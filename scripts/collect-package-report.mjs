import { access, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { basename, extname, relative, resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { currentRuntimePlatform, readLock, root, sha256 as sha256File } from './lib/runtime.mjs'
import { redactedJson } from './lib/redaction.mjs'
import { normalizedTreeManifest } from './lib/tree-manifest.mjs'
import { platformInputDigest } from './lib/source-inputs.mjs'
import { summarizeInspections, validatePackageManifest } from './lib/package-manifest.mjs'
import { isCombinedWindowsPackageReportInput } from './lib/package-report-mode.mjs'
import { loadPackageBaseline, packageBaselineArtifact, packageBaselineSourceTree } from './lib/package-baseline.mjs'
import { summarizeRuntimeAcceptance } from './lib/runtime-acceptance.mjs'
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

function hasArg(name) {
  return process.argv.some(value => value === name || value.startsWith(`${name}=`))
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
  let allocatedBytes = 0
  let allocationAvailable = true
  for (const entry of manifest.entries) {
    const metadata = await stat(resolve(path, entry.path), { bigint: true })
    if (typeof metadata.blocks !== 'bigint') {
      allocationAvailable = false
      break
    }
    allocatedBytes += Number(metadata.blocks * 512n)
  }
  return {
    status: 'present',
    bytes: manifest.bytes,
    files: manifest.files,
    ...(allocationAvailable ? { allocatedBytes } : { allocatedBytesStatus: 'unavailable-on-platform' }),
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

async function requiredJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`${label} 显式路径不存在：${path}`)
    }
    throw error
  }
}

function requireCombinedWindowsArgument(condition, message) {
  if (!condition) throw new Error(`combined Windows package report 输入不完整：${message}`)
}

const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const runtimeLock = await readLock()
const version = argValue('--version', pkg.version)
const baselineVersionArgument = argValue('--baseline-version', undefined)
if (version !== runtimeLock.applicationVersion && baselineVersionArgument === undefined) {
  throw new Error('为非当前应用版本生成 package report 时必须显式传入 --baseline-version')
}
const baselineVersion = baselineVersionArgument ?? runtimeLock.packageBaselineVersion
const baselineFixture = await loadPackageBaseline(root, baselineVersion)
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
// Windows 宿主模式下，NSIS / installed-tree manifest 与 installer 资产默认来自本机同一
// 构建；一旦调用方显式提供外部 Windows 资产（如跨版本契约测试或 cross-device 汇总），
// 就不再套用本机默认，避免版本/基线错配。
const windowsLocalManifestDefaults = process.platform === 'win32' && !hasArg('--windows-installer')
const windowsNsisManifestArgument = argValue(
  '--windows-nsis-manifest',
  windowsLocalManifestDefaults ? resolve(root, 'runtime/staging/package-release-win32-x64-nsis-installer.json') : undefined,
)
const windowsInstalledTreeManifestArgument = argValue(
  '--windows-installed-tree-manifest',
  windowsLocalManifestDefaults ? resolve(root, 'runtime/staging/package-release-win32-x64-windows-installed-tree.json') : undefined,
)
const windowsPortableManifestArgument = argValue('--windows-portable-manifest', portableManifestArgument)
const portableManifestExplicit = hasArg('--portable-manifest') || hasArg('--windows-portable-manifest')
const combinedWindowsInputExplicit = isCombinedWindowsPackageReportInput({
  args: process.argv,
  hostPlatform: process.platform,
})
if (combinedWindowsInputExplicit) {
  requireCombinedWindowsArgument(windowsNsisManifestArgument !== undefined, '缺少 --windows-nsis-manifest')
  requireCombinedWindowsArgument(windowsInstalledTreeManifestArgument !== undefined, '缺少 --windows-installed-tree-manifest')
  requireCombinedWindowsArgument(hasArg('--windows-portable-manifest'), '缺少 --windows-portable-manifest')
  requireCombinedWindowsArgument(windowsInstallerArg !== undefined, '缺少 --windows-installer')
  requireCombinedWindowsArgument(hasArg('--windows-portable'), '缺少 --windows-portable')
}
const releaseWindowsNsisManifest = windowsNsisManifestArgument === undefined
  ? null
  : await requiredJson(resolve(windowsNsisManifestArgument), 'Windows NSIS manifest')
const releaseWindowsInstalledTreeManifest = windowsInstalledTreeManifestArgument === undefined
  ? null
  : await requiredJson(resolve(windowsInstalledTreeManifestArgument), 'Windows installed-tree manifest')
const releasePortableManifest = windowsPortableManifestArgument !== 'none' &&
    (process.platform === 'win32' || portableManifestExplicit)
  ? portableManifestExplicit
      ? await requiredJson(resolve(windowsPortableManifestArgument), 'Windows portable manifest')
      : await optionalJson(resolve(windowsPortableManifestArgument))
  : null
// portable archive 的磁盘一致性策略：
// - 生产默认路径（未显式传 --portable-manifest）：必须与 bundle 下的 ZIP 一致，缺失即失败；
// - 外部传入的 manifest（测试/组合流程）：磁盘上不保证存在同名 ZIP，仅在显式提供
//   `--portable-archive <zip>` 时比对。
const portableArchiveArgument = argValue('--windows-portable', argValue('--portable-archive', undefined))
if (combinedWindowsInputExplicit) {
  if (!await exists(windowsInstaller)) {
    throw new Error(`Windows installer 显式路径不存在：${windowsInstaller}`)
  }
  const portableArchivePath = resolve(portableArchiveArgument)
  if (!await exists(portableArchivePath)) {
    throw new Error(`Windows portable ZIP 显式路径不存在：${portableArchivePath}`)
  }
}
const enforcePortableArchiveOnDisk = !portableManifestExplicit || portableArchiveArgument !== undefined
const runtimePlatform = currentRuntimePlatform()
const sourceInputSha256ByPlatform = {
  'darwin-arm64': await platformInputDigest(root, 'darwin-arm64'),
  'win32-x64': await platformInputDigest(root, 'win32-x64'),
}
const expectedReleaseArtifactKind = runtimePlatform === 'darwin-arm64' ? 'macos-app' : 'nsis-installer'

function baselineForArtifactKind(artifactKind) {
  return packageBaselineArtifact(baselineFixture, artifactKind)
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

function sourceDigestFieldForPlatform(platform) {
  return platform === 'darwin-arm64' ? 'macosSourceInputSha256' : 'windowsSourceInputSha256'
}

function manifestSummary(manifest, label, expectedArtifactKind, required, expectedPlatform = runtimePlatform) {
  if (manifest === null) {
    if (required && !allowMissingReleaseManifests) {
      throw new Error(`${label} 缺失，release package report 必须基于当前 package manifest`)
    }
    return { status: 'missing' }
  }
  validatePackageManifest(manifest)
  const reasons = []
  if (version === runtimeLock.applicationVersion && manifest.schemaVersion !== 6) reasons.push(`schemaVersion=${manifest.schemaVersion}`)
  if (manifest.mode !== 'release') reasons.push(`mode=${manifest.mode}`)
  if (manifest.applicationVersion !== version) reasons.push(`version=${manifest.applicationVersion}`)
  if (manifest.platform !== expectedPlatform) reasons.push(`platform=${manifest.platform}`)
  if (manifest.artifactKind !== expectedArtifactKind) reasons.push(`artifactKind=${manifest.artifactKind}`)
  const sourceDigestField = sourceDigestFieldForPlatform(expectedPlatform)
  if (manifest[sourceDigestField] !== sourceInputSha256ByPlatform[expectedPlatform]) reasons.push('source input digest 已过期')
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
    ...(manifest.runtime ? { runtime: manifest.runtime } : {}),
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
  'win32-x64',
)
const releaseWindowsNsisManifestSummary = manifestSummary(
  releaseWindowsNsisManifest,
  'Windows NSIS package manifest',
  'nsis-installer',
  false,
  'win32-x64',
)
const releaseWindowsInstalledTreeManifestSummary = manifestSummary(
  releaseWindowsInstalledTreeManifest,
  'Windows installed-tree package manifest',
  'windows-installed-tree',
  false,
  'win32-x64',
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
  return {
    app: baselineFixture.artifacts?.macosApp,
    dmg: baselineFixture.artifacts?.macosDmg,
    windowsInstaller: baselineFixture.artifacts?.windowsNsis,
    windowsInstalledTree: baselineFixture.artifacts?.windowsInstalledTree,
    runtimeNode: packageBaselineSourceTree(baselineFixture, runtimePlatform, 'runtime-node'),
    runtimeDsh: packageBaselineSourceTree(baselineFixture, runtimePlatform, 'runtime-dsh'),
    profileTemplate: packageBaselineSourceTree(baselineFixture, runtimePlatform, 'profile-template'),
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

function attachMeasuredAllocation(metric, measured, label) {
  if (!metric || metric.status !== 'present' || measured.status !== 'present') return metric
  if (metric.bytes !== measured.bytes || metric.files !== measured.files ||
      metric.contentSha256 !== measured.contentSha256) {
    throw new Error(`${label} 的 manifest 指标与磁盘树不一致，不能附加 allocated bytes`)
  }
  return {
    ...metric,
    ...(Number.isSafeInteger(measured.allocatedBytes)
      ? { allocatedBytes: measured.allocatedBytes }
      : { allocatedBytesStatus: measured.allocatedBytesStatus ?? 'unavailable-on-platform' }),
  }
}

function foreignRuntimePathsFromManifests(manifests) {
  const paths = new Set()
  for (const manifest of manifests.filter(Boolean)) {
    const expected = manifest.platform
    for (const inspection of manifest.inspections ?? []) {
      for (const resource of inspection.resources ?? []) {
        const match = resource.path.match(/(^|\/)runtime\/(?:node|sea)\/([^/]+)(\/|$)/)
        if (match && match[2] !== expected) paths.add(resource.path)
      }
    }
  }
  return [...paths].sort()
}

const validReleaseManifest = presentManifest(releaseManifest, releaseManifestSummary)
const validReleaseDmgManifest = presentManifest(releaseDmgManifest, releaseDmgManifestSummary)
const validReleasePortableManifest = presentManifest(releasePortableManifest, releasePortableManifestSummary)
const validReleaseWindowsNsisManifest = presentManifest(releaseWindowsNsisManifest, releaseWindowsNsisManifestSummary)
const validReleaseWindowsInstalledTreeManifest = presentManifest(
  releaseWindowsInstalledTreeManifest,
  releaseWindowsInstalledTreeManifestSummary,
)
const fallbackAppMetrics = await directoryMetrics(appPath)
const fallbackDmgMetrics = await dmgMetric()
const fallbackWindowsInstallerMetrics = await windowsInstallerMetric()
const inspectedAppMetrics = inspectionMetric(validReleaseManifest, 'macos-app')
const appMetrics = attachBaselineDelta(
  inspectedAppMetrics === null
    ? fallbackAppMetrics
    : attachMeasuredAllocation(inspectedAppMetrics, fallbackAppMetrics, 'macOS app'),
  'app',
)
const dmgMetrics = attachBaselineDelta(inspectionMetric(validReleaseDmgManifest, 'macos-dmg') ?? fallbackDmgMetrics, 'dmg')
const windowsInstallerMetrics = attachBaselineDelta(
  inspectionMetric(validReleaseWindowsNsisManifest, 'nsis-installer') ??
    inspectionMetric(validReleaseManifest, 'nsis-installer') ??
    fallbackWindowsInstallerMetrics,
  'windowsInstaller',
)
const windowsInstalledTreeMetrics = attachBaselineDelta(
  inspectionMetric(validReleaseWindowsInstalledTreeManifest, 'windows-installed-tree') ??
    { status: 'missing' },
  'windowsInstalledTree',
)
// portable 为首版：只记录 staging/archive/extracted 三方指标，不做 v0.1.3 基线比较（REQ-1408）。
const portableStagingMetrics = inspectionMetric(validReleasePortableManifest, 'staging')
const portableArchiveMetrics = inspectionMetric(validReleasePortableManifest, 'archive')
const portableExtractedMetrics = inspectionMetric(validReleasePortableManifest, 'extracted')
if (validReleasePortableManifest !== null) {
  if (portableManifestExplicit && portableArchiveArgument === undefined) {
    throw new Error('显式 Windows portable manifest 必须同时提供 --windows-portable 或 --portable-archive 以校验 ZIP 资产')
  }
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
const rawRuntimeSeaMetrics = inspectionMetric(validReleaseManifest, 'runtime-sea') ??
  await directoryMetrics(resolve(argValue('--runtime-sea', resolve(root, `runtime/sea/${runtimePlatform}`))))
const baselineRuntimeNode = packageBaselineSourceTree(baselineFixture, runtimePlatform, 'runtime-node')
const baselineRuntimeDsh = packageBaselineSourceTree(baselineFixture, runtimePlatform, 'runtime-dsh')
const runtimeSeaMetrics = rawRuntimeSeaMetrics?.status === 'present' &&
    Number.isSafeInteger(baselineRuntimeNode?.bytes) && Number.isSafeInteger(baselineRuntimeDsh?.bytes)
  ? {
      ...rawRuntimeSeaMetrics,
      baselineVersion: baselineFixture.baselineVersion,
      baselineStatus: baselineRuntimeNode.status === 'canonical' && baselineRuntimeDsh.status === 'canonical'
        ? 'canonical-combined'
        : 'reference-combined',
      baselineBytes: baselineRuntimeNode.bytes + baselineRuntimeDsh.bytes,
      baselineFiles: baselineRuntimeNode.files + baselineRuntimeDsh.files,
      deltaBytes: rawRuntimeSeaMetrics.bytes - baselineRuntimeNode.bytes - baselineRuntimeDsh.bytes,
      deltaFiles: rawRuntimeSeaMetrics.files - baselineRuntimeNode.files - baselineRuntimeDsh.files,
    }
  : rawRuntimeSeaMetrics
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
if (validReleaseWindowsNsisManifest !== null) {
  // Windows 宿主模式下 NSIS manifest 与 installer 都默认来自本机同一构建；
  // 只有 cross-device（macOS 汇总）才要求显式 --windows-installer 校验外部资产。
  if (process.platform !== 'win32' && !explicitWindowsInstaller) {
    throw new Error('显式 Windows NSIS manifest 必须同时提供 --windows-installer 以校验安装包资产')
  }
  const installerInspection = validReleaseWindowsNsisManifest.inspections.find(item => item.subject === 'nsis-installer')
  if (!installerInspection || fallbackWindowsInstallerMetrics.status !== 'present' ||
      installerInspection.sha256 !== fallbackWindowsInstallerMetrics.sha256 ||
      installerInspection.size?.bytes !== fallbackWindowsInstallerMetrics.bytes) {
    throw new Error('package report 的显式 Windows installer 与 manifest 不一致')
  }
}
const windowsInstalledTreeArgument = argValue('--windows-installed-tree', undefined)
if (validReleaseWindowsInstalledTreeManifest !== null && windowsInstalledTreeArgument !== undefined) {
  const installedTreeInspection = validReleaseWindowsInstalledTreeManifest.inspections
    .find(item => item.subject === 'windows-installed-tree')
  const installedTreeOnDisk = await directoryMetrics(resolve(windowsInstalledTreeArgument))
  if (!installedTreeInspection || installedTreeOnDisk.status !== 'present' ||
      installedTreeInspection.contentSha256 !== installedTreeOnDisk.contentSha256 ||
      installedTreeInspection.size?.bytes !== installedTreeOnDisk.bytes ||
      installedTreeInspection.size?.files !== installedTreeOnDisk.files) {
    throw new Error('package report 的 Windows installed-tree 与 manifest 不一致')
  }
}
const foreignRuntimePaths = foreignRuntimePathsFromManifests([
  validReleaseManifest,
  validReleaseDmgManifest,
  validReleaseWindowsNsisManifest,
  validReleaseWindowsInstalledTreeManifest,
  validReleasePortableManifest,
])
if (foreignRuntimePaths.length > 0) {
  throw new Error(`package report 检测到异平台 Runtime：${foreignRuntimePaths.join(', ')}`)
}
const schema6Report = validReleaseManifest?.schemaVersion === 6
const runtimeAcceptanceArgument = argValue(
  '--runtime-acceptance',
  resolve(root, `runtime/staging/sea-performance-${runtimePlatform}.json`),
)
const explicitRuntimeAcceptance = hasArg('--runtime-acceptance')
const runtimeAcceptanceEvidence = explicitRuntimeAcceptance
  ? await requiredJson(resolve(runtimeAcceptanceArgument), 'Runtime acceptance evidence')
  : await optionalJson(resolve(runtimeAcceptanceArgument))
const runtimeOnDeviceArgument = argValue(
  '--runtime-on-device',
  resolve(root, `runtime/staging/sea-on-device-${runtimePlatform}.json`),
)
const explicitRuntimeOnDevice = hasArg('--runtime-on-device')
const runtimeOnDeviceEvidence = explicitRuntimeOnDevice
  ? await requiredJson(resolve(runtimeOnDeviceArgument), 'Runtime on-device evidence')
  : await optionalJson(resolve(runtimeOnDeviceArgument))
let runtimeAcceptance = { status: 'missing' }
if (schema6Report && runtimeAcceptanceEvidence !== null) {
  if (runtimeOnDeviceEvidence === null) {
    throw new Error('Runtime acceptance evidence 存在时必须提供当前设备的 Runtime on-device evidence')
  }
  const schema = JSON.parse(await readFile(resolve(root, 'runtime/manifest/sea-performance.schema.json'), 'utf8'))
  const validate = new Ajv2020({ strict: false }).compile(schema)
  if (!validate(runtimeAcceptanceEvidence)) {
    throw new Error(`Runtime acceptance evidence schema 无效：${JSON.stringify(validate.errors)}`)
  }
  const onDeviceSchema = JSON.parse(await readFile(resolve(root, 'runtime/manifest/sea-on-device.schema.json'), 'utf8'))
  const validateOnDevice = new Ajv2020({ strict: false }).compile(onDeviceSchema)
  if (!validateOnDevice(runtimeOnDeviceEvidence)) {
    throw new Error(`Runtime on-device evidence schema 无效：${JSON.stringify(validateOnDevice.errors)}`)
  }
  const gateExceptionDocument = process.platform === 'win32'
    ? await optionalJson(resolve(root, 'runtime/manifest/windows-gate-exceptions.json'))
    : null
  const performanceGateExceptions = gateExceptionDocument?.exceptions?.performanceGates ?? []
  runtimeAcceptance = summarizeRuntimeAcceptance(runtimeAcceptanceEvidence, {
    applicationVersion: runtimeLock.applicationVersion,
    target: runtimePlatform,
    dshVersion: runtimeLock.dsh.version,
    nodeVersion: runtimeLock.node.version,
    seaSha256: validReleaseManifest.runtime.executable.sha256,
  }, runtimeOnDeviceEvidence, performanceGateExceptions)
}

function firstRunFootprint() {
  if (!schema6Report || runtimeAcceptance.status !== 'present') return { status: 'missing' }
  const installTree = runtimePlatform === 'darwin-arm64' ? appMetrics : windowsInstalledTreeMetrics
  if (installTree.status !== 'present') return { status: 'missing-install-tree' }
  const external = runtimeAcceptance.firstRun
  const total = {
    files: installTree.files + external.totalFiles,
    bytes: installTree.bytes + external.totalBytes,
    ...(Number.isSafeInteger(installTree.allocatedBytes)
      ? { allocatedBytes: installTree.allocatedBytes + external.totalAllocatedBytes }
      : { allocatedBytesStatus: installTree.allocatedBytesStatus ?? 'unavailable-on-platform' }),
  }
  const baseline = baselineForArtifactKind(
    runtimePlatform === 'darwin-arm64' ? 'macos-app' : 'windows-installed-tree',
  )
  return {
    status: 'present',
    installTree: {
      files: installTree.files,
      bytes: installTree.bytes,
      ...(Number.isSafeInteger(installTree.allocatedBytes)
        ? { allocatedBytes: installTree.allocatedBytes }
        : { allocatedBytesStatus: installTree.allocatedBytesStatus ?? 'unavailable-on-platform' }),
    },
    runtimeOwnedExternal: {
      files: external.totalFiles,
      bytes: external.totalBytes,
      allocatedBytes: external.totalAllocatedBytes,
    },
    total,
    baseline: baseline === null ? { status: 'missing' } : {
      version: baselineFixture.baselineVersion,
      status: baseline.status,
      files: baseline.files,
      bytes: baseline.bytes,
      allocatedBytesStatus: baselineFixture.measurement?.allocatedBytes ?? 'not-recorded',
      ...(Number.isSafeInteger(baseline.files) ? { deltaFiles: total.files - baseline.files } : {}),
      ...(Number.isSafeInteger(baseline.bytes) ? { deltaBytes: total.bytes - baseline.bytes } : {}),
    },
  }
}

const report = {
  schemaVersion: schema6Report ? 3 : 2,
  application: { name: 'DeepShell Agent', version },
  generatedAt: new Date().toISOString(),
  platform: { os: process.platform, arch: process.arch },
  baselineVersion: baselineFixture?.baselineVersion ?? null,
  assets: {
    app: appMetrics,
    dmg: dmgMetrics,
    windowsInstaller: windowsInstallerMetrics,
    windowsInstalledTree: windowsInstalledTreeMetrics,
    windowsPortable: windowsPortableMetrics,
    ...(schema6Report ? { runtimeSea: runtimeSeaMetrics } : {
      runtimeNode: runtimeNodeMetrics,
      runtimeDsh: runtimeDshMetrics,
    }),
    profileTemplate: profileTemplateMetrics,
  },
  foreignRuntimePaths,
  ...(schema6Report ? {
    runtime: validReleaseManifest.runtime,
    runtimeAcceptance,
    firstRunFootprint: firstRunFootprint(),
  } : {}),
  manifests: {
    releasePackageManifest: releaseManifestSummary,
    releaseDmgManifest: releaseDmgManifestSummary,
    releaseWindowsNsisManifest: releaseWindowsNsisManifestSummary,
    releaseWindowsInstalledTreeManifest: releaseWindowsInstalledTreeManifestSummary,
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
