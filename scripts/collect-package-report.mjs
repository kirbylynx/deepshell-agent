import { createHash } from 'node:crypto'
import { access, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'
import { currentRuntimePlatform, root } from './lib/runtime.mjs'
import { redactedJson } from './lib/redaction.mjs'
import { normalizedTreeManifest } from './lib/tree-manifest.mjs'
import { platformInputDigest } from './lib/source-inputs.mjs'
import { summarizeInspections } from './lib/package-manifest.mjs'
import { uniqueMatchingArtifact } from './lib/artifact-selection.mjs'

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

async function directoryMetrics(path) {
  if (!await exists(path)) return { status: 'missing' }
  const manifest = await normalizedTreeManifest(path)
  return {
    status: 'present',
    bytes: manifest.bytes,
    files: manifest.files,
    contentSha256: manifest.contentSha256,
    algorithm: manifest.algorithm,
  }
}

async function fileMetric(path) {
  if (!await exists(path)) return { status: 'missing', asset: basename(path) }
  const info = await stat(path)
  const content = await readFile(path)
  return { status: 'present', asset: basename(path), bytes: info.size, sha256: createHash('sha256').update(content).digest('hex') }
}

async function exactWindowsInstaller(version) {
  const directory = resolve(root, 'src-tauri/target/release/bundle/nsis')
  if (!await exists(directory)) return null
  const name = uniqueMatchingArtifact(
    await readdir(directory),
    file => extname(file).toLowerCase() === '.exe' && file.includes(version) && file.toLowerCase().endsWith('-setup.exe'),
    `Windows ${version} installer`,
  )
  return name === null ? null : resolve(directory, name)
}

async function optionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const version = argValue('--version', pkg.version)
const outputDirectory = resolve(argValue('--output-dir', resolve(root, 'runtime/staging', `release-v${version}`)))
await mkdir(outputDirectory, { recursive: true })
const appPath = resolve(argValue('--app', resolve(root, 'src-tauri/target/release/bundle/macos/DeepShell Agent.app')))
const dmgArg = argValue('--dmg', undefined)
const explicitDmg = dmgArg !== undefined
const dmg = dmgArg === undefined && process.platform === 'darwin'
  ? resolve(root, 'src-tauri/target/release/bundle/dmg', `DeepShell Agent_${version}_aarch64.dmg`)
  : dmgArg === undefined ? null : resolve(dmgArg)
const windowsInstallerArg = argValue('--windows-installer', undefined)
const explicitWindowsInstaller = windowsInstallerArg !== undefined
const windowsInstaller = windowsInstallerArg === undefined ? await exactWindowsInstaller(version) : resolve(windowsInstallerArg)
const dmgMetric = async () => {
  if (dmg === null) return { status: 'missing' }
  if (!explicitDmg && !basename(dmg).includes(version)) {
    return { status: 'stale-version', asset: basename(dmg), expectedVersion: version }
  }
  return fileMetric(dmg)
}
const windowsInstallerMetric = async () => {
  if (windowsInstaller === null) return { status: 'missing' }
  if (!explicitWindowsInstaller && !basename(windowsInstaller).includes(version)) {
    return { status: 'stale-version', asset: basename(windowsInstaller), expectedVersion: version }
  }
  return fileMetric(windowsInstaller)
}
const licenseInventoryArgument = argValue('--license-inventory', resolve(root, 'runtime/staging/license-inventory.json'))
const explicitLicenseInventory = process.argv.some(value => value === '--license-inventory' || value.startsWith('--license-inventory='))
let licenseInventory = await optionalJson(resolve(licenseInventoryArgument))
let staleLicenseInventoryVersion = null
if (licenseInventory !== null && licenseInventory.application?.version !== version) {
  if (explicitLicenseInventory) {
    throw new Error(`license inventory 版本不一致：expected ${version}, got ${licenseInventory.application?.version ?? 'unknown'}`)
  }
  staleLicenseInventoryVersion = licenseInventory.application?.version ?? 'unknown'
  licenseInventory = null
}
const packageManifestArgument = argValue('--package-manifest', resolve(root, 'runtime/staging/package-release.json'))
const dmgManifestArgument = argValue('--dmg-manifest', resolve(root, 'runtime/staging/package-release-darwin-arm64-macos-dmg.json'))
const releaseManifest = packageManifestArgument === 'none' ? null : await optionalJson(resolve(packageManifestArgument))
const releaseDmgManifest = process.platform === 'darwin' && dmgManifestArgument !== 'none'
  ? await optionalJson(resolve(dmgManifestArgument))
  : null
const runtimePlatform = currentRuntimePlatform()
const currentSourceInputSha256 = await platformInputDigest(root, runtimePlatform)
const sourceDigestField = runtimePlatform === 'darwin-arm64' ? 'macosSourceInputSha256' : 'windowsSourceInputSha256'

function manifestSummary(manifest) {
  if (manifest === null) return { status: 'missing' }
  if (manifest.schemaVersion !== 5 || manifest.mode !== 'release' || manifest.applicationVersion !== version ||
      manifest.platform !== runtimePlatform || manifest[sourceDigestField] !== currentSourceInputSha256) {
    return {
      status: 'stale-or-incompatible',
      schemaVersion: manifest.schemaVersion ?? null,
      artifactKind: manifest.artifactKind ?? null,
    }
  }
  return {
    status: 'present',
    schemaVersion: manifest.schemaVersion,
    artifactKind: manifest.artifactKind,
    resourceCount: Array.isArray(manifest.resources) ? manifest.resources.length : 0,
    inspections: summarizeInspections(manifest.inspections ?? []),
  }
}
const releaseManifestSummary = manifestSummary(releaseManifest)
const releaseDmgManifestSummary = manifestSummary(releaseDmgManifest)
const appMetrics = await directoryMetrics(appPath)
const dmgMetrics = await dmgMetric()
const windowsInstallerMetrics = await windowsInstallerMetric()
if (releaseManifestSummary.status === 'present' && appMetrics.status === 'present') {
  const appInspection = releaseManifest.inspections.find(item => item.subject === 'macos-app')
  if (appInspection && (appInspection.contentSha256 !== appMetrics.contentSha256 ||
      appInspection.size?.bytes !== appMetrics.bytes || appInspection.size?.files !== appMetrics.files)) {
    throw new Error('package report 的 app 资产与 manifest 不一致')
  }
}
if (releaseDmgManifestSummary.status === 'present' && dmgMetrics.status === 'present') {
  const dmgInspection = releaseDmgManifest.inspections.find(item => item.subject === 'macos-dmg')
  if (!dmgInspection || dmgInspection.sha256 !== dmgMetrics.sha256 || dmgInspection.size?.bytes !== dmgMetrics.bytes) {
    throw new Error('package report 的 DMG 资产与 manifest 不一致')
  }
}
if (releaseManifestSummary.status === 'present' && releaseManifest.artifactKind === 'nsis-installer' &&
    windowsInstallerMetrics.status === 'present') {
  const installerInspection = releaseManifest.inspections.find(item => item.subject === 'nsis-installer')
  if (!installerInspection || installerInspection.sha256 !== windowsInstallerMetrics.sha256 ||
      installerInspection.size?.bytes !== windowsInstallerMetrics.bytes) {
    throw new Error('package report 的 Windows installer 与 manifest 不一致')
  }
}
const report = {
  schemaVersion: 2,
  application: { name: 'DeepShell Agent', version },
  generatedAt: new Date().toISOString(),
  platform: { os: process.platform, arch: process.arch },
  assets: {
    app: appMetrics,
    dmg: dmgMetrics,
    windowsInstaller: windowsInstallerMetrics,
    runtimeNode: await directoryMetrics(resolve(argValue('--runtime-node', resolve(root, 'runtime/node')))),
    runtimeDsh: await directoryMetrics(resolve(argValue('--runtime-dsh', resolve(root, 'runtime/dsh')))),
    profileTemplate: await directoryMetrics(resolve(argValue('--profile-template', resolve(root, 'runtime/profile-template')))),
  },
  manifests: {
    releasePackageManifest: releaseManifestSummary,
    releaseDmgManifest: releaseDmgManifestSummary,
    licenseInventory: staleLicenseInventoryVersion !== null ? {
      status: 'stale-version',
      foundVersion: staleLicenseInventoryVersion,
      expectedVersion: version,
    } : licenseInventory === null ? { status: 'missing' } : {
      status: 'present',
      bundledDshNpmPackages: licenseInventory.bundledDshNpmPackages?.length ?? 0,
      directBuildAndTestNpmPackages: licenseInventory.directBuildAndTestNpmPackages?.length ?? 0,
      rustRegistryPackages: licenseInventory.rustRegistryPackages?.length ?? 0
    }
  },
  privacy: {
    pathPolicy: 'only aggregate metrics and asset basenames are recorded',
    rootRelativeOnly: true
  }
}
if (JSON.stringify(report).includes(root) || JSON.stringify(report).includes(relative('/', root))) {
  throw new Error('package report 包含本地绝对路径')
}
const output = resolve(outputDirectory, 'package-report.json')
await writeFile(output, redactedJson(report))
console.log(`package report written: ${output}`)
