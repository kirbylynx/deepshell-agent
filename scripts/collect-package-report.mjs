import { access, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'
import { currentRuntimePlatform, root, sha256 as sha256File } from './lib/runtime.mjs'
import { redactedJson } from './lib/redaction.mjs'
import { normalizedTreeManifest } from './lib/tree-manifest.mjs'
import { platformInputDigest } from './lib/source-inputs.mjs'
import { summarizeInspections, validatePackageManifestV5 } from './lib/package-manifest.mjs'
import {
  assertArtifactNameMatchesVersion,
  isMacosDmgName,
  isWindowsNsisInstallerName,
  selectWindowsNsisInstallerName,
} from './lib/artifact-selection.mjs'

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
  return { status: 'present', asset: basename(path), bytes: info.size, sha256: await sha256File(path) }
}

async function exactWindowsInstaller(version) {
  const directory = resolve(root, 'src-tauri/target/release/bundle/nsis')
  if (!await exists(directory)) return null
  const name = selectWindowsNsisInstallerName((await readdir(directory)).filter(file => extname(file).toLowerCase() === '.exe'), version)
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
const baselineFixture = await optionalJson(resolve(root, 'tests/fixtures/package-size-baselines/v0.1.3.json'))
const version = argValue('--version', pkg.version)
const allowMissingReleaseManifests = process.argv.includes('--allow-missing-release-manifests')
const outputDirectory = resolve(argValue('--output-dir', resolve(root, 'runtime/staging')))
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
  if (!explicitDmg && !isMacosDmgName(basename(dmg), version)) {
    return { status: 'stale-version', asset: basename(dmg), expectedVersion: version }
  }
  if (explicitDmg) assertArtifactNameMatchesVersion(basename(dmg), version, 'macOS DMG', isMacosDmgName)
  return fileMetric(dmg)
}
const windowsInstallerMetric = async () => {
  if (windowsInstaller === null) return { status: 'missing' }
  if (!explicitWindowsInstaller && !isWindowsNsisInstallerName(basename(windowsInstaller), version)) {
    return { status: 'stale-version', asset: basename(windowsInstaller), expectedVersion: version }
  }
  if (explicitWindowsInstaller) {
    assertArtifactNameMatchesVersion(basename(windowsInstaller), version, 'Windows installer', isWindowsNsisInstallerName)
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
const portableManifestArgument = argValue('--portable-manifest', resolve(root, 'runtime/staging/package-release-win32-x64-windows-portable.json'))
const releasePortableManifest = process.platform === 'win32' && portableManifestArgument !== 'none'
  ? await optionalJson(resolve(portableManifestArgument))
  : null
// portable archive 的磁盘一致性策略：
// - 生产默认路径（未显式传 --portable-manifest）：必须与 bundle 下的 ZIP 一致，缺失即失败；
// - 外部传入的 manifest（测试/组合流程）：磁盘上不保证存在同名 ZIP，仅在显式提供
//   `--portable-archive <zip>` 时比对。
const portableManifestExplicit = process.argv.some(value => value === '--portable-manifest' || value.startsWith('--portable-manifest='))
const portableArchiveArgument = argValue('--portable-archive', undefined)
const enforcePortableArchiveOnDisk = !portableManifestExplicit || portableArchiveArgument !== undefined
const runtimePlatform = currentRuntimePlatform()
const currentSourceInputSha256 = await platformInputDigest(root, runtimePlatform)
const sourceDigestField = runtimePlatform === 'darwin-arm64' ? 'macosSourceInputSha256' : 'windowsSourceInputSha256'
const expectedReleaseArtifactKind = runtimePlatform === 'darwin-arm64' ? 'macos-app' : 'nsis-installer'

function baselineForArtifactKind(artifactKind) {
  return {
    'macos-app': baselineFixture?.artifacts?.macosApp,
    'macos-dmg': baselineFixture?.artifacts?.macosDmg,
    'nsis-installer': baselineFixture?.artifacts?.windowsNsis,
  }[artifactKind] ?? null
}

function incompatibleManifestSummary(label, manifest, reasons) {
  if (!allowMissingReleaseManifests) {
    throw new Error(`${label} 不可用于 release package report：${reasons.join('；')}`)
  }
  return {
    status: 'stale-or-incompatible',
    schemaVersion: manifest?.schemaVersion ?? null,
    artifactKind: manifest?.artifactKind ?? null,
    reasons,
  }
}

function manifestSummary(manifest, label, expectedArtifactKind, required) {
  if (manifest === null) {
    if (required && !allowMissingReleaseManifests) {
      throw new Error(`${label} 缺失，release package report 必须基于当前 schema 5 manifest`)
    }
    return { status: 'missing' }
  }
  validatePackageManifestV5(manifest)
  const reasons = []
  if (manifest.mode !== 'release') reasons.push(`mode=${manifest.mode}`)
  if (manifest.applicationVersion !== version) reasons.push(`version=${manifest.applicationVersion}`)
  if (manifest.platform !== runtimePlatform) reasons.push(`platform=${manifest.platform}`)
  if (manifest.artifactKind !== expectedArtifactKind) reasons.push(`artifactKind=${manifest.artifactKind}`)
  if (manifest[sourceDigestField] !== currentSourceInputSha256) reasons.push('source input digest 已过期')
  if (baselineFixture === null) {
    reasons.push('baseline fixture 缺失')
  } else {
    const baselineArtifact = baselineForArtifactKind(manifest.artifactKind)
    if (manifest.baseline?.canonicalSourceRef !== baselineFixture.canonicalSource?.tag) reasons.push('baseline tag 不匹配')
    if (manifest.baseline?.canonicalSourceCommit !== baselineFixture.canonicalSource?.peeledCommit) reasons.push('baseline commit 不匹配')
    if (manifest.baseline?.baselineSourceInputSha256 !== baselineFixture.canonicalSource?.baselineSourceInputSha256) {
      reasons.push('baseline source input digest 不匹配')
    }
    if (manifest.baseline?.algorithmVersion !== baselineFixture.measurement?.algorithm) reasons.push('baseline algorithm 不匹配')
    if (baselineArtifact !== null && manifest.baseline?.status !== baselineArtifact.status) {
      reasons.push(`baseline status=${manifest.baseline?.status}`)
    }
    if (baselineArtifact?.contentSha256 && manifest.baseline?.treeContentSha256 !== baselineArtifact.contentSha256) {
      reasons.push('baseline tree content hash 不匹配')
    }
    if (baselineArtifact?.sha256 && manifest.baseline?.artifactSha256 !== baselineArtifact.sha256) {
      reasons.push('baseline artifact hash 不匹配')
    }
  }
  if (reasons.length > 0) return incompatibleManifestSummary(label, manifest, reasons)
  return {
    status: 'present',
    schemaVersion: manifest.schemaVersion,
    artifactKind: manifest.artifactKind,
    resourceCount: Array.isArray(manifest.resources) ? manifest.resources.length : 0,
    baseline: manifest.baseline,
    inspections: summarizeInspections(manifest.inspections ?? []),
  }
}
const releaseManifestSummary = manifestSummary(releaseManifest, 'release package manifest', expectedReleaseArtifactKind, true)
const releaseDmgManifestSummary = manifestSummary(
  releaseDmgManifest,
  'release DMG manifest',
  'macos-dmg',
  runtimePlatform === 'darwin-arm64',
)
const releasePortableManifestSummary = manifestSummary(
  releasePortableManifest,
  'portable package manifest',
  'windows-portable',
  runtimePlatform === 'win32-x64',
)
function presentManifest(manifest, summary) {
  return manifest !== null && summary.status === 'present' ? manifest : null
}

function inspectionMetric(manifest, subject) {
  const inspection = manifest?.inspections?.find(item => item.subject === subject)
  if (!inspection) return null
  return {
    status: inspection.status === 'equivalent' ? 'present' : inspection.status,
    bytes: inspection.size.bytes,
    files: inspection.size.files,
    runtimePlatforms: inspection.runtimePlatforms,
    ...(inspection.sha256 ? { sha256: inspection.sha256 } : {}),
    ...(inspection.contentSha256 ? { contentSha256: inspection.contentSha256 } : {}),
    ...(inspection.inspectionMode === 'file-metadata-only' && inspection.resources?.[0]
      ? { asset: basename(inspection.resources[0].path) }
      : {}),
  }
}

function baselineArtifactFor(assetKey) {
  if (!baselineFixture?.artifacts && !baselineFixture?.sourceTrees) return null
  const runtimeNodeKey = runtimePlatform === 'darwin-arm64' ? 'darwinNode' : 'windowsNode'
  return {
    app: baselineFixture.artifacts?.macosApp,
    dmg: baselineFixture.artifacts?.macosDmg,
    windowsInstaller: baselineFixture.artifacts?.windowsNsis,
    runtimeNode: baselineFixture.sourceTrees?.[runtimeNodeKey],
    runtimeDsh: baselineFixture.sourceTrees?.dsh,
    profileTemplate: baselineFixture.sourceTrees?.profileTemplate,
  }[assetKey] ?? null
}

function attachBaselineDelta(metric, assetKey) {
  const baseline = baselineArtifactFor(assetKey)
  if (!metric || metric.status !== 'present' || baseline?.status !== 'canonical' && baseline?.status !== 'reference-only') return metric
  return {
    ...metric,
    baselineVersion: baselineFixture.baselineVersion,
    baselineStatus: baseline.status,
    ...(Number.isSafeInteger(baseline.bytes) ? { deltaBytes: metric.bytes - baseline.bytes } : {}),
    ...(Number.isSafeInteger(baseline.files) && Number.isSafeInteger(metric.files)
      ? { deltaFiles: metric.files - baseline.files }
      : {}),
  }
}

function foreignRuntimePathsFromManifests(manifests) {
  const expected = runtimePlatform
  const paths = new Set()
  for (const manifest of manifests.filter(Boolean)) {
    for (const inspection of manifest.inspections ?? []) {
      for (const resource of inspection.resources ?? []) {
        const match = resource.path.match(/(^|\/)runtime\/node\/([^/]+)(\/|$)/)
        if (match && match[2] !== expected) paths.add(resource.path)
      }
    }
  }
  return [...paths].sort()
}

const validReleaseManifest = presentManifest(releaseManifest, releaseManifestSummary)
const validReleaseDmgManifest = presentManifest(releaseDmgManifest, releaseDmgManifestSummary)
const validReleasePortableManifest = presentManifest(releasePortableManifest, releasePortableManifestSummary)
const fallbackAppMetrics = await directoryMetrics(appPath)
const fallbackDmgMetrics = await dmgMetric()
const fallbackWindowsInstallerMetrics = await windowsInstallerMetric()
const appMetrics = attachBaselineDelta(inspectionMetric(validReleaseManifest, 'macos-app') ?? fallbackAppMetrics, 'app')
const dmgMetrics = attachBaselineDelta(inspectionMetric(validReleaseDmgManifest, 'macos-dmg') ?? fallbackDmgMetrics, 'dmg')
const windowsInstallerMetrics = attachBaselineDelta(
  inspectionMetric(validReleaseManifest, 'nsis-installer') ?? fallbackWindowsInstallerMetrics,
  'windowsInstaller',
)
// portable 为首版：只记录 staging/archive/extracted 三方指标，不做 v0.1.3 基线比较（REQ-1408）。
const portableStagingMetrics = inspectionMetric(validReleasePortableManifest, 'staging')
const portableArchiveMetrics = inspectionMetric(validReleasePortableManifest, 'archive')
const portableExtractedMetrics = inspectionMetric(validReleasePortableManifest, 'extracted')
if (validReleasePortableManifest !== null) {
  // 三个 subject 必须存在：缺失时不能静默记录 null（与 verify-package-size 的存在性断言一致）。
  if (portableStagingMetrics === null || portableArchiveMetrics === null || portableExtractedMetrics === null) {
    throw new Error('package report 的 portable manifest 缺少 staging/archive/extracted inspection')
  }
  if (portableStagingMetrics.contentSha256 !== portableExtractedMetrics.contentSha256 ||
      portableStagingMetrics.bytes !== portableExtractedMetrics.bytes ||
      portableStagingMetrics.files !== portableExtractedMetrics.files) {
    throw new Error('package report 的 portable staging 与 extracted 不一致')
  }
  // archive 必须与磁盘上的 ZIP 一致（与 nsis 的资产-vs-manifest 比对对称）：
  // manifest 中的资源路径已由 schema 校验为相对路径，可直接拼到 bundle 目录。
  if (enforcePortableArchiveOnDisk) {
    const archiveInspection = validReleasePortableManifest.inspections.find(item => item.subject === 'archive')
    const archiveName = archiveInspection?.resources?.[0]?.path
    const archivePath = portableArchiveArgument !== undefined
      ? resolve(portableArchiveArgument)
      : typeof archiveName === 'string'
        ? resolve(root, 'src-tauri/target/release/bundle/portable', archiveName)
        : null
    const archiveOnDisk = archivePath === null ? { status: 'missing' } : await fileMetric(archivePath)
    if (archiveOnDisk.status !== 'present' || archiveInspection.sha256 !== archiveOnDisk.sha256 ||
        archiveInspection.size?.bytes !== archiveOnDisk.bytes) {
      throw new Error('package report 的 portable archive 与磁盘 ZIP 不一致')
    }
  }
}
const windowsPortableMetrics = validReleasePortableManifest === null ? { status: 'missing' } : {
  status: 'present',
  staging: portableStagingMetrics,
  archive: portableArchiveMetrics,
  extracted: portableExtractedMetrics,
}
const runtimeNodeMetrics = attachBaselineDelta(
  inspectionMetric(validReleaseManifest, 'runtime-node') ??
    await directoryMetrics(resolve(argValue('--runtime-node', resolve(root, `runtime/node/${runtimePlatform}`)))),
  'runtimeNode',
)
const runtimeDshMetrics = attachBaselineDelta(
  inspectionMetric(validReleaseManifest, 'runtime-dsh') ??
    await directoryMetrics(resolve(argValue('--runtime-dsh', resolve(root, 'runtime/dsh')))),
  'runtimeDsh',
)
const profileTemplateMetrics = attachBaselineDelta(
  inspectionMetric(validReleaseManifest, 'profile-template') ??
    await directoryMetrics(resolve(argValue('--profile-template', resolve(root, 'runtime/profile-template')))),
  'profileTemplate',
)
if (releaseManifestSummary.status === 'present' && releaseManifest.artifactKind === 'macos-app') {
  const appInspection = releaseManifest.inspections.find(item => item.subject === 'macos-app')
  if (!appInspection || fallbackAppMetrics.status !== 'present' ||
      appInspection.contentSha256 !== fallbackAppMetrics.contentSha256 ||
      appInspection.size?.bytes !== fallbackAppMetrics.bytes || appInspection.size?.files !== fallbackAppMetrics.files) {
    throw new Error('package report 的 app 资产与 manifest 不一致')
  }
}
if (releaseDmgManifestSummary.status === 'present') {
  const dmgInspection = releaseDmgManifest.inspections.find(item => item.subject === 'macos-dmg')
  if (!dmgInspection || fallbackDmgMetrics.status !== 'present' ||
      dmgInspection.sha256 !== fallbackDmgMetrics.sha256 || dmgInspection.size?.bytes !== fallbackDmgMetrics.bytes) {
    throw new Error('package report 的 DMG 资产与 manifest 不一致')
  }
}
if (releaseManifestSummary.status === 'present' && releaseManifest.artifactKind === 'nsis-installer') {
  const installerInspection = releaseManifest.inspections.find(item => item.subject === 'nsis-installer')
  if (!installerInspection || fallbackWindowsInstallerMetrics.status !== 'present' ||
      installerInspection.sha256 !== fallbackWindowsInstallerMetrics.sha256 ||
      installerInspection.size?.bytes !== fallbackWindowsInstallerMetrics.bytes) {
    throw new Error('package report 的 Windows installer 与 manifest 不一致')
  }
}
const foreignRuntimePaths = foreignRuntimePathsFromManifests([validReleaseManifest, validReleaseDmgManifest])
if (foreignRuntimePaths.length > 0) {
  throw new Error(`package report 检测到异平台 Runtime：${foreignRuntimePaths.join(', ')}`)
}
const report = {
  schemaVersion: 2,
  application: { name: 'DeepShell Agent', version },
  generatedAt: new Date().toISOString(),
  platform: { os: process.platform, arch: process.arch },
  baselineVersion: baselineFixture?.baselineVersion ?? null,
  assets: {
    app: appMetrics,
    dmg: dmgMetrics,
    windowsInstaller: windowsInstallerMetrics,
    windowsPortable: windowsPortableMetrics,
    runtimeNode: runtimeNodeMetrics,
    runtimeDsh: runtimeDshMetrics,
    profileTemplate: profileTemplateMetrics,
  },
  foreignRuntimePaths,
  manifests: {
    releasePackageManifest: releaseManifestSummary,
    releaseDmgManifest: releaseDmgManifestSummary,
    releasePortableManifest: releasePortableManifestSummary,
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
