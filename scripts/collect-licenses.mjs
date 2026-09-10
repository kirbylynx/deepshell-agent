import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { readLock, root } from './lib/runtime.mjs'

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function packageName(path, value) {
  return value.name ?? path.split('node_modules/').at(-1)
}

const runtimeLock = JSON.parse(
  await readFile(resolve(root, 'runtime/manifest/dsh-install/package-lock.json'), 'utf8')
)
const lock = await readLock()
const runtimePackages = []
for (const [path, value] of Object.entries(runtimeLock.packages)) {
  if (!path) continue
  runtimePackages.push({
    name: packageName(path, value),
    version: value.version,
    license: value.license,
    installed: await exists(resolve(root, 'runtime/dsh', path)),
    optional: value.optional === true
  })
}
runtimePackages.sort((left, right) =>
  left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
)

const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const directNames = [...Object.keys(rootPackage.dependencies ?? {}), ...Object.keys(rootPackage.devDependencies ?? {})]
const buildPackages = []
for (const name of [...new Set(directNames)].sort()) {
  const manifest = JSON.parse(await readFile(resolve(root, 'node_modules', name, 'package.json'), 'utf8'))
  buildPackages.push({
    name,
    version: manifest.version,
    license: manifest.license ?? 'UNDECLARED',
    scope: rootPackage.dependencies?.[name] ? 'build-and-runtime-client' : 'build-or-test-only'
  })
}

const cargo = JSON.parse(execFileSync('cargo', [
  'metadata',
  '--locked',
  '--format-version',
  '1',
  '--manifest-path',
  resolve(root, 'src-tauri/Cargo.toml')
], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }))
const rustPackages = cargo.packages
  .filter(pkg => pkg.source !== null)
  .map(pkg => ({
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? 'UNDECLARED',
    source: pkg.source
  }))
  .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))

const output = {
  schemaVersion: 1,
  application: { name: 'DeepShell Agent', version: rootPackage.version },
  bundledNode: {
    version: lock.node.version,
    licenseFiles: Object.fromEntries(
      Object.keys(lock.node.targets).map(target => [target, `runtime/node/${target}/LICENSE`])
    )
  },
  bundledDshNpmPackages: runtimePackages,
  directBuildAndTestNpmPackages: buildPackages,
  rustRegistryPackages: rustPackages,
  notes: [
    'installed=false 表示 package-lock 中锁定但未安装的可选平台包，不进入当前交付物。',
    '本清单是技术盘点，不构成法律意见；分发前仍需完成许可证和商标审查。'
  ]
}

const stagingDirectory = resolve(root, 'runtime/staging')
await mkdir(stagingDirectory, { recursive: true })
await writeFile(resolve(stagingDirectory, 'license-inventory.json'), JSON.stringify(output, null, 2) + '\n')
console.log(`license inventory written: ${runtimePackages.length} npm runtime packages, ${rustPackages.length} Rust packages`)
