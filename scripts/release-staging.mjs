import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { root } from './lib/runtime.mjs'
import { redactedJson } from './lib/redaction.mjs'

function argValue(name, fallback) {
  const prefix = `${name}=`
  const inline = process.argv.find(value => value.startsWith(prefix))
  if (inline) return inline.slice(prefix.length)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function sha256(path) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

async function newestByExtension(directory, extension) {
  if (!await exists(directory)) return null
  const files = (await readdir(directory)).filter(file => extname(file).toLowerCase() === extension).sort()
  return files.length === 0 ? null : resolve(directory, files.at(-1))
}

async function newestDmg() {
  return newestByExtension(resolve(root, 'src-tauri/target/release/bundle/dmg'), '.dmg')
}

async function newestWindowsInstaller() {
  return newestByExtension(resolve(root, 'src-tauri/target/release/bundle/nsis'), '.exe')
}

async function copyIfPresent(source, target, assets, label) {
  if (!await exists(source)) {
    assets.push({ label, status: 'missing', asset: basename(target) })
    return
  }
  await copyFile(source, target)
  assets.push({ label, status: 'present', asset: basename(target), sha256: await sha256(target) })
}

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const version = argValue('--version', pkg.version)
const outputDirectory = resolve(argValue('--output-dir', resolve(root, 'runtime/staging', `release-v${version}`)))
await mkdir(outputDirectory, { recursive: true })

const assets = []
const dmgArg = argValue('--dmg', undefined)
const explicitDmg = dmgArg !== undefined
const dmg = dmgArg === undefined ? await newestDmg() : resolve(dmgArg)
const windowsInstallerArg = argValue('--windows-installer', undefined)
const explicitWindowsInstaller = windowsInstallerArg !== undefined
const windowsInstaller = windowsInstallerArg === undefined ? await newestWindowsInstaller() : resolve(windowsInstallerArg)
if (dmg === null) {
  assets.push({ label: 'macos-dmg', status: 'missing', asset: `DeepShell.Agent_${version}_aarch64.dmg` })
} else if (!explicitDmg && !basename(dmg).includes(version)) {
  assets.push({
    label: 'macos-dmg',
    status: 'stale-version',
    asset: basename(dmg),
    expectedVersion: version
  })
} else {
  const target = resolve(outputDirectory, `DeepShell.Agent_${version}_aarch64.dmg`)
  await copyFile(dmg, target)
  assets.push({ label: 'macos-dmg', status: 'present', asset: basename(target), sha256: await sha256(target) })
}
if (windowsInstaller === null) {
  assets.push({ label: 'windows-nsis', status: 'missing', asset: `DeepShell.Agent_${version}_x64-setup.exe` })
} else if (!explicitWindowsInstaller && !basename(windowsInstaller).includes(version)) {
  assets.push({
    label: 'windows-nsis',
    status: 'stale-version',
    asset: basename(windowsInstaller),
    expectedVersion: version
  })
} else {
  const target = resolve(outputDirectory, `DeepShell.Agent_${version}_x64-setup.exe`)
  await copyFile(windowsInstaller, target)
  assets.push({ label: 'windows-nsis', status: 'present', asset: basename(target), sha256: await sha256(target) })
}
await copyIfPresent(
  resolve(argValue('--license-inventory', resolve(root, 'runtime/staging/license-inventory.json'))),
  resolve(outputDirectory, `deepshell-agent-v${version}-license-inventory.json`),
  assets,
  'license-inventory'
)
await copyIfPresent(
  resolve(argValue('--sbom', resolve(root, 'runtime/staging/sbom.json'))),
  resolve(outputDirectory, `deepshell-agent-v${version}-sbom.json`),
  assets,
  'sbom'
)
await copyIfPresent(
  resolve(argValue('--package-report', resolve(outputDirectory, 'package-report.json'))),
  resolve(outputDirectory, `deepshell-agent-v${version}-package-report.json`),
  assets,
  'package-report'
)

const presentAssets = assets.filter(asset => asset.status === 'present')
const sums = presentAssets.map(asset => `${asset.sha256}  ${asset.asset}`).join('\n')
await writeFile(resolve(outputDirectory, 'SHA256SUMS.txt'), sums.length === 0 ? '' : `${sums}\n`)

const notes = [
  `# DeepShell Agent v${version} Developer Preview`,
  '',
  'This draft is generated locally by `pnpm release:stage`.',
  '',
  '## Distribution status',
  '',
  '- macOS arm64: developer preview packaging lane.',
  '- Code signing: ad-hoc/local signing only.',
  '- Apple notarization: not performed.',
  '- Windows x64: route/checklist prepared; installer pass requires real Windows or CI validation.',
  '',
  '## Assets',
  '',
  ...assets.map(asset => `- ${asset.asset}: ${asset.status}`),
  ''
]
await writeFile(resolve(outputDirectory, 'RELEASE_NOTES.md'), notes.join('\n'))
await writeFile(resolve(outputDirectory, 'release-manifest.json'), redactedJson({
  schemaVersion: 1,
  application: { name: 'DeepShell Agent', version },
  generatedAt: new Date().toISOString(),
  assets,
  publishPolicy: 'local staging only; GitHub release creation and asset upload require explicit user authorization',
  windowsStatus: 'pending-real-windows-or-ci-validation'
}))

console.log(`release staging written: ${outputDirectory}`)
