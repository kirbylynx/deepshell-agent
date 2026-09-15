import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const stableCompare = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right))

function canonicalWorkingTreeContent(content) {
  const probe = content.subarray(0, Math.min(content.length, 8_000))
  if (probe.includes(0)) return content
  const output = []
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 13 && content[index + 1] === 10) {
      output.push(10)
      index += 1
    } else {
      output.push(content[index])
    }
  }
  return Buffer.from(output)
}

export const v013BaselineSourceInputs = [
  'package.json',
  'pnpm-lock.yaml',
  'rust-toolchain.toml',
  'tsconfig.json',
  'vite.config.ts',
  'src-bootstrap',
  'src-tauri/build.rs',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'src-tauri/capabilities',
  'src-tauri/icons',
  'src-tauri/src',
  'dsh/bundles/deepshell-desktop',
  'runtime/manifest',
  'scripts/lib/runtime.mjs',
  'scripts/lib/source-inputs.mjs',
  'scripts/lib/package-platform.mjs',
  'scripts/prepare-runtime.mjs',
  'scripts/prepare-profile.mjs',
  'scripts/sign-package.mjs',
  'scripts/package-mvp.mjs',
  'scripts/create-macos-dmg.mjs',
  'scripts/verify-package.mjs',
  'scripts/capture-package-manifest.mjs',
  'scripts/compare-e2e-release.mjs',
]

const currentSharedSourceInputs = [
  '.gitattributes',
  'package.json',
  'pnpm-lock.yaml',
  'rust-toolchain.toml',
  'tsconfig.json',
  'vite.config.ts',
  'src-bootstrap',
  'src-tauri/build.rs',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/tauri.conf.json',
  'src-tauri/capabilities',
  'src-tauri/icons',
  'src-tauri/src',
  'dsh/bundles/deepshell-desktop',
  'runtime/manifest',
  'scripts/lib/package-platform.mjs',
  'scripts/lib/package-platform.d.mts',
  'scripts/lib/artifact-selection.mjs',
  'scripts/lib/artifact-selection.d.mts',
  'scripts/lib/package-manifest.mjs',
  'scripts/lib/package-manifest.d.mts',
  'scripts/lib/package-size.mjs',
  'scripts/lib/package-size.d.mts',
  'scripts/lib/process-plan.mjs',
  'scripts/lib/process-plan.d.mts',
  'scripts/lib/redaction.mjs',
  'scripts/lib/runtime.mjs',
  'scripts/lib/source-inputs.mjs',
  'scripts/lib/source-inputs.d.mts',
  'scripts/lib/tree-manifest.mjs',
  'scripts/lib/tree-manifest.d.mts',
  'scripts/lib/windows-acceptance.mjs',
  'scripts/lib/windows-acceptance.d.mts',
  'scripts/capture-package-baseline.mjs',
  'scripts/build-package.mjs',
  'scripts/capture-package-manifest.mjs',
  'scripts/collect-licenses.mjs',
  'scripts/collect-package-report.mjs',
  'scripts/compare-e2e-release.mjs',
  'scripts/generate-sbom.mjs',
  'scripts/package-mvp.mjs',
  'scripts/prepare-profile.mjs',
  'scripts/prepare-runtime.mjs',
  'scripts/release-staging.mjs',
  'scripts/security-audit.mjs',
  'scripts/smoke-dsh.mjs',
  'scripts/verify-package-size.mjs',
  'scripts/verify-package.mjs',
  'scripts/verify-profile.mjs',
  'scripts/verify-runtime.mjs',
  'tests',
]

export const platformSourceInputs = {
  'darwin-arm64': [
    ...currentSharedSourceInputs,
    'src-tauri/tauri.macos.conf.json',
    'scripts/create-macos-dmg.mjs',
    'scripts/lib/macos-dmg.mjs',
    'scripts/run-e2e.mjs',
    'scripts/sign-package.mjs',
    'wdio.conf.ts',
  ],
  'win32-x64': [
    ...currentSharedSourceInputs,
    'src-tauri/tauri.windows.conf.json',
    'scripts/verify-windows-route.mjs',
    '.github/workflows/windows-release.yml',
  ],
}

export const packageSourceInputs = [...new Set(Object.values(platformSourceInputs).flat())]

export async function deterministicInputDigest(workspaceRoot, inputs = packageSourceInputs) {
  const records = []
  async function walk(path) {
    const metadata = await lstat(path)
    const name = relative(workspaceRoot, path).split(sep).join('/')
    if (metadata.isDirectory()) {
      const entries = await readdir(path)
      entries.sort(stableCompare)
      for (const entry of entries) await walk(resolve(path, entry))
      return
    }
    if (metadata.isSymbolicLink()) {
      records.push({ path: name, type: 'symlink', content: Buffer.from((await readlink(path)).split(sep).join('/')) })
      return
    }
    if (!metadata.isFile()) throw new Error(`不支持的构建输入类型：${name}`)
    records.push({ path: name, type: 'file', content: canonicalWorkingTreeContent(await readFile(path)) })
  }
  for (const input of [...inputs].sort(stableCompare)) await walk(resolve(workspaceRoot, input))

  const hash = createHash('sha256')
  for (const record of records.sort((left, right) => stableCompare(left.path, right.path))) {
    hash.update(record.type)
    hash.update('\0')
    hash.update(record.path)
    hash.update('\0')
    hash.update(String(record.content.length))
    hash.update('\0')
    hash.update(record.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function platformInputDigest(workspaceRoot, runtimePlatform) {
  const inputs = platformSourceInputs[runtimePlatform]
  if (!inputs) throw new Error(`不支持的平台输入 digest：${runtimePlatform}`)
  return deterministicInputDigest(workspaceRoot, inputs)
}

export function v013BaselineInputDigest(sourceRoot) {
  return gitRevisionInputDigest(sourceRoot, 'HEAD', v013BaselineSourceInputs)
}

export async function gitRevisionInputDigest(repositoryRoot, revision, inputs) {
  for (const input of inputs) {
    await execFileAsync('git', ['cat-file', '-e', `${revision}:${input}`], { cwd: repositoryRoot })
  }
  const { stdout } = await execFileAsync('git', [
    'ls-tree', '-r', '-z', revision, '--', ...[...inputs].sort(stableCompare),
  ], { cwd: repositoryRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 })
  const records = stdout.toString('utf8').split('\0').filter(Boolean).map(line => {
    const match = line.match(/^(\d+) blob ([0-9a-f]+)\t(.+)$/)
    if (!match) throw new Error(`不支持的 Git tree 记录：${line}`)
    return { mode: match[1], object: match[2], path: match[3] }
  })
  if (records.length === 0) throw new Error(`Git revision ${revision} 未解析到 baseline 输入`)
  const hash = createHash('sha256')
  for (const record of records.sort((left, right) => stableCompare(left.path, right.path))) {
    const { stdout: content } = await execFileAsync('git', ['cat-file', 'blob', record.object], {
      cwd: repositoryRoot, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
    })
    const type = record.mode === '120000' ? 'symlink' : 'file'
    hash.update(type)
    hash.update('\0')
    hash.update(record.path)
    hash.update('\0')
    hash.update(String(content.length))
    hash.update('\0')
    hash.update(content)
    hash.update('\0')
  }
  return hash.digest('hex')
}
