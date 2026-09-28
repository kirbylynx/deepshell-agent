import { execFile } from 'node:child_process'
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { readLock, root, sha256 } from './lib/runtime.mjs'
import { redactedJson } from './lib/redaction.mjs'
import { platformInputDigest } from './lib/source-inputs.mjs'
import {
  assertReleaseEvidenceIdentityMatchesExpected,
  assertReleaseEvidenceIdentityMatchesReport,
} from './lib/release-evidence-identity.mjs'
import { WindowsStatusCode, windowsManifestFields, windowsNotesLine } from './lib/windows-acceptance.mjs'
import { collectDirectBuildAndTestNpmPackages } from './lib/direct-npm-dependencies.mjs'
import {
  assertArtifactNameMatchesVersion,
  isMacosDmgName,
  isWindowsNsisInstallerName,
  isWindowsPortableZipName,
  selectMacosDmgName,
  selectWindowsNsisInstallerName,
  selectWindowsPortableZipName,
} from './lib/artifact-selection.mjs'

const execFileAsync = promisify(execFile)

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

function explicitArgValue(name) {
  const prefix = `${name}=`
  const inline = process.argv.find(value => value.startsWith(prefix))
  if (inline) return { explicit: true, value: inline.slice(prefix.length) }
  const index = process.argv.indexOf(name)
  return index >= 0 ? { explicit: true, value: process.argv[index + 1] } : { explicit: false }
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isSameOrChild(path, parent) {
  const child = resolve(path)
  const base = resolve(parent)
  const fromBase = relative(base, child)
  return fromBase === '' || (!fromBase.startsWith('..') && !fromBase.startsWith(sep))
}

function assertExplicitInputOutsideOutput(option, outputDirectory) {
  const input = explicitArgValue(option)
  if (input.explicit && isSameOrChild(input.value, outputDirectory)) {
    throw new Error(`${option} 显式输入不能位于将被替换的 release staging output 内：${input.value}`)
  }
}

async function assertOutputDirectoryMayBeReplaced(version, outputDirectory) {
  if (!await exists(outputDirectory)) return
  let entries
  try {
    entries = await readdir(outputDirectory)
  } catch {
    throw new Error(`release staging output 必须是目录：${outputDirectory}`)
  }
  if (entries.length === 0) return
  const manifestPath = resolve(outputDirectory, 'release-manifest.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch {
    throw new Error(`拒绝替换非空且缺少 release-manifest sentinel 的目录：${outputDirectory}`)
  }
  const actualVersion = manifest.application?.version
  if (manifest.application?.name !== 'DeepShell Agent' || actualVersion !== version) {
    throw new Error(`拒绝替换 release-manifest sentinel 不匹配的目录：expected ${version}, got ${actualVersion ?? 'unknown'}`)
  }
}

async function matchingAsset(directory, version, selector, extension, candidatePredicate = () => true) {
  if (!await exists(directory)) return { status: 'missing' }
  const files = (await readdir(directory))
    .filter(file => extname(file).toLowerCase() === extension && candidatePredicate(file))
    .sort()
  const selected = selector(files, version)
  if (selected !== null) return { status: 'present', path: resolve(directory, selected) }
  if (files.length === 0) return { status: 'missing' }
  throw new Error(`未找到当前版本 ${version} 的合法发布资产；候选文件：${files.join(', ')}`)
}

async function currentDmg(version) {
  const directory = resolve(argValue('--dmg-dir', resolve(root, 'src-tauri/target/release/bundle/dmg')))
  return matchingAsset(directory, version, selectMacosDmgName, '.dmg')
}

async function currentWindowsInstaller(version) {
  const directory = resolve(argValue('--windows-installer-dir', resolve(root, 'src-tauri/target/release/bundle/nsis')))
  return matchingAsset(
    directory,
    version,
    selectWindowsNsisInstallerName,
    '.exe',
    file => file.toLowerCase().endsWith('-setup.exe'),
  )
}

async function currentWindowsPortable(version) {
  const directory = resolve(argValue('--windows-portable-dir', resolve(root, 'src-tauri/target/release/bundle/portable')))
  return matchingAsset(
    directory,
    version,
    selectWindowsPortableZipName,
    '.zip',
    file => file.toLowerCase().endsWith('-portable.zip'),
  )
}

async function copyJsonIfPresent(source, target, assets, label, version) {
  if (!await exists(source)) {
    assets.push({ label, status: 'missing', asset: basename(target) })
    return null
  }
  const content = await readFile(source, 'utf8')
  const json = JSON.parse(content)
  const actualVersion = json.application?.version ?? json.version
  if (actualVersion !== version) {
    throw new Error(`${label} 版本不一致：expected ${version}, got ${actualVersion ?? 'unknown'}`)
  }
  await writeFile(target, content)
  assets.push({ label, status: 'present', asset: basename(target), sha256: await sha256(target) })
  return json
}

function presentAsset(assets, label) {
  const asset = assets.find(item => item.label === label)
  if (!asset || asset.status !== 'present') {
    throw new Error(`combined release staging 要求 ${label} 资产存在，但状态为 ${asset?.status ?? 'missing'}`)
  }
  return asset
}

function assertPackageReportMetric(report, path, label) {
  const value = path.reduce((current, key) => current?.[key], report)
  if (value?.status !== 'present') {
    throw new Error(`combined release staging 的 package report 缺少 present 指标：${label}`)
  }
  return value
}

function assertPackageReportSummary(report, key) {
  const summary = report.manifests?.[key]
  if (summary?.status !== 'present') {
    throw new Error(`combined release staging 的 package report 缺少 present manifest summary：${key}`)
  }
  if (summary.runtime?.provisional !== false) {
    throw new Error(`combined release staging 拒绝 provisional Runtime：${key}`)
  }
}

function assertReportShaMatchesAsset(metricSha, asset, label) {
  if (metricSha !== asset.sha256) {
    throw new Error(`combined release staging 的 package report ${label} sha 与 staging 资产不一致`)
  }
}

function assertReportFileMetricMatchesAsset(metric, asset, label) {
  assertReportShaMatchesAsset(metric.sha256, asset, label)
  if (metric.bytes !== asset.bytes) {
    throw new Error(`combined release staging 的 package report ${label} bytes 与 staging 资产不一致`)
  }
}

function assertExplicitCombinedInput(name) {
  const input = explicitArgValue(name)
  if (!input.explicit || typeof input.value !== 'string' || input.value.trim() === '' || input.value.startsWith('--')) {
    throw new Error(`combined release staging 要求显式 ${name}`)
  }
}

function windowsReleaseMetadataFromProvenance(version, provenance) {
  const record = provenance.windowsAcceptance?.record ??
    `deepshell-agent-v${version}-windows-provenance.json`
  const round = provenance.round
  const summary = `accepted-on-device by ${provenance.origin} provenance round ${round}`
  const scope = `v${version}: accepted-on-device from ${provenance.origin} provenance round ${round}`
  return {
    notesLine:
      `- Windows x64: ${summary} for v${version} (see ${record}). Known unfixed defects ship with this version: recorded in Windows provenance.`,
    manifestFields: {
      windowsStatusCode: WindowsStatusCode.AcceptedOnDevice,
      windowsStatusSummary: summary,
      windowsAcceptanceRecord: record,
      windowsAcceptanceScope: scope,
      windowsAcceptanceOrigin: provenance.origin,
      windowsAcceptanceRound: round,
    },
  }
}

export function validateCompletedSecurityAudit(report) {
  // 正式 combined staging 不能只复制审计文件；必须拒绝 dry-run、缺项及失败报告。
  const labels = ['node-root-production', 'node-root-all', 'dsh-runtime', 'rust']
  if (report?.schemaVersion !== 1 || report.status !== 'completed'
    || !Array.isArray(report.audits) || report.audits.length !== labels.length) {
    throw new Error('combined release staging 要求完整且 completed 的 security audit')
  }
  for (const label of labels) {
    const matches = report.audits.filter(item => item?.label === label)
    const audit = matches[0]
    if (matches.length !== 1 || audit.status !== 'completed') {
      throw new Error(`combined release staging security audit 子项未完成：${label}`)
    }
    const vulnerabilities = audit.vulnerabilities
    const valid = label === 'rust'
      ? vulnerabilities?.found === false && vulnerabilities.count === 0
        && Array.isArray(vulnerabilities.list) && vulnerabilities.list.length === 0
      : ['info', 'low', 'moderate', 'high', 'critical'].every(key =>
        Number.isSafeInteger(vulnerabilities?.[key]) && vulnerabilities[key] >= 0)
        && vulnerabilities.critical === 0
    if (!valid) throw new Error(`combined release staging security audit 漏洞摘要无效或阻断：${label}`)
  }
}

function assertSupportEvidenceIdentities(report, evidence) {
  for (const [label, value] of Object.entries(evidence)) {
    assertReleaseEvidenceIdentityMatchesReport(value, report, label)
  }
}

function packageNameFromLockPath(path, value) {
  return value.name ?? path.split('node_modules/').at(-1)
}

function dshPackageCoverageKey(pkg) {
  return [
    pkg?.name ?? '',
    pkg?.version ?? '',
    pkg?.license ?? '',
    pkg?.optional === true ? 'optional' : 'required',
  ].join('\0')
}

function directPackageCoverageKey(pkg) {
  return [
    pkg?.name ?? '',
    pkg?.version ?? '',
    pkg?.license ?? 'UNDECLARED',
    pkg?.scope ?? '',
  ].join('\0')
}

function rustPackageCoverageKey(pkg) {
  return [
    pkg?.name ?? '',
    pkg?.version ?? '',
    pkg?.license ?? 'UNDECLARED',
    pkg?.source ?? '',
  ].join('\0')
}

function multiset(values, keyOf) {
  const counts = new Map()
  for (const value of values) {
    const key = keyOf(value)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function assertSameMultiset(actualItems, expectedItems, keyOf, label, describeItem) {
  const actual = multiset(actualItems, keyOf)
  const expected = multiset(expectedItems, keyOf)
  for (const [key, count] of expected) {
    const actualCount = actual.get(key) ?? 0
    if (actualCount !== count) {
      throw new Error(`combined release staging 的 ${label} 权威依赖覆盖不一致：缺少或数量不符 ${describeItem(key)}，expected ${count}, got ${actualCount}`)
    }
  }
  for (const [key, count] of actual) {
    const expectedCount = expected.get(key) ?? 0
    if (expectedCount !== count) {
      throw new Error(`combined release staging 的 ${label} 权威依赖覆盖不一致：存在非权威依赖 ${describeItem(key)}，expected ${expectedCount}, got ${count}`)
    }
  }
}

let expectedLicenseInventoryPayloadPromise

export async function collectExpectedLicenseInventoryPayload() {
  if (expectedLicenseInventoryPayloadPromise) return expectedLicenseInventoryPayloadPromise
  expectedLicenseInventoryPayloadPromise = (async () => {
    const runtimeLock = JSON.parse(
      await readFile(resolve(root, 'runtime/manifest/dsh-install/package-lock.json'), 'utf8')
    )
    const lock = await readLock()
    const bundledDshNpmPackages = []
    for (const [path, value] of Object.entries(runtimeLock.packages ?? {})) {
      if (!path) continue
      bundledDshNpmPackages.push({
        name: packageNameFromLockPath(path, value),
        version: value.version,
        license: value.license,
        installed: await exists(resolve(root, 'runtime/dsh', path)),
        optional: value.optional === true,
      })
    }
    bundledDshNpmPackages.sort((left, right) =>
      left.name.localeCompare(right.name) || left.version.localeCompare(right.version)
    )

    const directBuildAndTestNpmPackages = await collectDirectBuildAndTestNpmPackages(root)

    const { stdout } = await execFileAsync('cargo', [
      'metadata',
      '--locked',
      '--format-version',
      '1',
      '--manifest-path',
      resolve(root, 'src-tauri/Cargo.toml'),
    ], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    const cargo = JSON.parse(stdout)
    const rustRegistryPackages = cargo.packages
      .filter(pkg => pkg.source !== null)
      .map(pkg => ({
        name: pkg.name,
        version: pkg.version,
        license: pkg.license ?? 'UNDECLARED',
        source: pkg.source,
      }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.version.localeCompare(right.version))

    return {
      bundledNode: {
        version: lock.node.version,
        distributionLicensePath: 'licenses/Node.js-LICENSE',
        licenseFiles: Object.fromEntries(
          Object.keys(lock.node.targets).map(target => [target, `runtime/node/${target}/LICENSE`])
        ),
      },
      bundledDshNpmPackages,
      embeddedSeaPackager: {
        name: lock.sea.packager.package,
        version: lock.sea.packager.version,
        patchSha256: lock.sea.packager.patch.sha256,
        distributionLicensePath: 'licenses/yao-pkg-LICENSE',
      },
      directBuildAndTestNpmPackages,
      rustRegistryPackages,
    }
  })()
  return expectedLicenseInventoryPayloadPromise
}

async function validateLicenseInventory(report, label) {
  if (report?.schemaVersion !== 1 || report.application?.name !== 'DeepShell Agent' ||
      typeof report.application?.version !== 'string' ||
      typeof report.bundledNode?.version !== 'string' ||
      !Array.isArray(report.bundledDshNpmPackages) ||
      !Array.isArray(report.directBuildAndTestNpmPackages) ||
      !Array.isArray(report.rustRegistryPackages) ||
      report.embeddedSeaPackager?.name !== '@yao-pkg/pkg') {
    throw new Error(`combined release staging 的 ${label} 不是有效 license inventory`)
  }
  if (report.bundledDshNpmPackages.length === 0 ||
      !report.bundledDshNpmPackages.some(pkg => pkg?.name === '@deepseek-ai/dsh' && pkg.installed === true) ||
      report.directBuildAndTestNpmPackages.length === 0 ||
      !report.directBuildAndTestNpmPackages.some(pkg => pkg?.name === '@yao-pkg/pkg') ||
      report.rustRegistryPackages.length === 0) {
    throw new Error(`combined release staging 的 ${label} 依赖覆盖不完整`)
  }
  const expected = await collectExpectedLicenseInventoryPayload()
  if (report.bundledNode.version !== expected.bundledNode.version ||
      report.embeddedSeaPackager.version !== expected.embeddedSeaPackager.version ||
      report.embeddedSeaPackager.patchSha256 !== expected.embeddedSeaPackager.patchSha256) {
    throw new Error(`combined release staging 的 ${label} 权威依赖覆盖不一致：Node 或 SEA packager 身份不匹配`)
  }
  assertSameMultiset(
    report.bundledDshNpmPackages,
    expected.bundledDshNpmPackages,
    dshPackageCoverageKey,
    label,
    key => `DSH npm ${key.split('\0').slice(0, 2).join('@')}`,
  )
  for (const pkg of report.bundledDshNpmPackages) {
    if (pkg.optional !== true && pkg.installed !== true) {
      throw new Error(`combined release staging 的 ${label} 权威依赖覆盖不一致：非 optional DSH 包未安装 ${pkg.name}@${pkg.version}`)
    }
    if (typeof pkg.installed !== 'boolean') {
      throw new Error(`combined release staging 的 ${label} 权威依赖覆盖不一致：DSH 包缺少 installed 布尔值 ${pkg.name}@${pkg.version}`)
    }
  }
  assertSameMultiset(
    report.directBuildAndTestNpmPackages,
    expected.directBuildAndTestNpmPackages,
    directPackageCoverageKey,
    label,
    key => `direct npm ${key.split('\0').slice(0, 2).join('@')}`,
  )
  assertSameMultiset(
    report.rustRegistryPackages,
    expected.rustRegistryPackages,
    rustPackageCoverageKey,
    label,
    key => `cargo ${key.split('\0').slice(0, 2).join('@')}`,
  )
}

function componentKey(component) {
  return [
    component?.type ?? '',
    component?.name ?? '',
    component?.version ?? '',
    component?.scope ?? '',
    component?.license ?? '',
    component?.optional === true ? 'optional' : '',
    component?.installed === true ? 'installed' : component?.installed === false ? 'not-installed' : '',
  ].join('\0')
}

function expectedSbomComponentsFromLicense(inventory) {
  return [
    {
      name: inventory.application.name,
      version: inventory.application.version,
      type: 'application',
      license: 'MIT',
      scope: 'root',
    },
    {
      name: 'Bundled Node.js',
      version: inventory.bundledNode.version,
      type: 'runtime',
      license: 'Node.js bundled licenses',
      scope: 'bundled-runtime',
    },
    ...inventory.bundledDshNpmPackages.map(pkg => ({
      name: pkg.name,
      version: pkg.version,
      type: 'npm',
      license: pkg.license ?? 'UNDECLARED',
      scope: 'bundled-dsh-runtime',
      optional: pkg.optional === true,
      installed: pkg.installed === true,
    })),
    ...inventory.directBuildAndTestNpmPackages.map(pkg => ({
      name: pkg.name,
      version: pkg.version,
      type: 'npm',
      license: pkg.license ?? 'UNDECLARED',
      scope: pkg.scope,
    })),
    ...inventory.rustRegistryPackages.map(pkg => ({
      name: pkg.name,
      version: pkg.version,
      type: 'cargo',
      license: pkg.license ?? 'UNDECLARED',
      scope: 'tauri-runtime',
    })),
  ]
}

function validateSbom(report, label) {
  if (report?.schemaVersion !== 1 || report.format !== 'deepshell-sbom-baseline' ||
      report.application?.name !== 'DeepShell Agent' ||
      typeof report.application?.version !== 'string' ||
      report.source !== 'license-inventory' ||
      !Number.isSafeInteger(report.componentCount) || report.componentCount < 1 ||
      !Array.isArray(report.components) || report.components.length !== report.componentCount ||
      !report.components.some(component => component?.type === 'application' && component.name === 'DeepShell Agent')) {
    throw new Error(`combined release staging 的 ${label} 不是有效 SBOM`)
  }
}

function validateSbomMatchesLicense(sbom, licenseInventory, label) {
  const expected = expectedSbomComponentsFromLicense(licenseInventory)
  if (sbom.componentCount !== expected.length || sbom.components.length !== expected.length) {
    throw new Error(`combined release staging 的 ${label} component count 与 license inventory 不一致`)
  }
  assertSameMultiset(
    sbom.components,
    expected,
    componentKey,
    label,
    key => key.split('\0').slice(0, 3).join(':'),
  )
}

function expectedIdentityFromRuntime(runtime, version, label) {
  if (runtime?.format !== 'sea' || !['darwin-arm64', 'win32-x64'].includes(runtime.platform) ||
      runtime.provisional !== false || typeof version !== 'string' ||
      typeof runtime.sourceInputSha256 !== 'string' || typeof runtime.artifactSourceCommit !== 'string' ||
      !Number.isSafeInteger(runtime.executable?.bytes) || typeof runtime.executable?.sha256 !== 'string') {
    throw new Error(`combined release staging 的 ${label} 缺少可绑定的 SEA 身份`)
  }
  return {
    schemaVersion: 1,
    status: 'present',
    source: 'package-report',
    application: { name: 'DeepShell Agent', version },
    platform: runtime.platform,
    sourceInputSha256: runtime.sourceInputSha256,
    artifactSourceCommit: runtime.artifactSourceCommit,
    seaRuntime: {
      sha256: runtime.executable.sha256,
      bytes: runtime.executable.bytes,
      provisional: runtime.provisional,
    },
  }
}

async function validateSupportEvidenceGroup(evidence, expectedIdentity, prefix) {
  await validateLicenseInventory(evidence.licenseInventory, `${prefix} license inventory`)
  validateSbom(evidence.sbom, `${prefix} SBOM`)
  validateSbomMatchesLicense(evidence.sbom, evidence.licenseInventory, `${prefix} SBOM`)
  validateCompletedSecurityAudit(evidence.securityAudit)
  assertReleaseEvidenceIdentityMatchesExpected(evidence.licenseInventory, expectedIdentity, `${prefix} license-inventory`)
  assertReleaseEvidenceIdentityMatchesExpected(evidence.sbom, expectedIdentity, `${prefix} sbom`)
  assertReleaseEvidenceIdentityMatchesExpected(evidence.securityAudit, expectedIdentity, `${prefix} security-audit`)
}

function artifactForAsset(provenance, asset, expectedBasenames) {
  const artifacts = Array.isArray(provenance.artifacts) ? provenance.artifacts : []
  return artifacts.find(item => expectedBasenames.includes(basename(item.path ?? '')) &&
    item.sha256 === asset.sha256 && item.bytes === asset.bytes)
}

async function assertCommitIsHeadAncestor(commit, label = 'artifactSourceCommit') {
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
    throw new Error(`combined release staging 的 ${label} 缺少有效 artifactSourceCommit`)
  }
  try {
    await execFileAsync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { cwd: root })
  } catch {
    throw new Error(`combined release staging 的 ${label} 不是当前 HEAD 祖先`)
  }
}

async function validateWindowsProvenance(provenance, report, assets, version) {
  if (provenance === null) {
    throw new Error('combined release staging 要求显式 --windows-provenance')
  }
  if (provenance.schemaVersion !== 1 || provenance.origin !== 'windows-local' ||
      provenance.version !== version || provenance.platform !== 'win32-x64' ||
      typeof provenance.round !== 'string' || !/^w\d+[a-z]?$/i.test(provenance.round)) {
    throw new Error('combined release staging 的 Windows provenance origin/version/platform/round 无效')
  }
  if (provenance.windowsAcceptance?.status !== 'accepted-on-device' ||
      provenance.windowsAcceptance?.round !== provenance.round) {
    throw new Error('combined release staging 要求 Windows provenance 记录 accepted-on-device 真机验收')
  }
  await assertCommitIsHeadAncestor(provenance.artifactSourceCommit, 'Windows artifactSourceCommit')
  const windowsSourceInputSha256 = await platformInputDigest(root, 'win32-x64')
  if (provenance.windowsSourceInputSha256 !== windowsSourceInputSha256) {
    throw new Error('combined release staging 的 Windows provenance source input digest 已过期')
  }
  if (provenance.seaRuntime?.provisional !== false ||
      provenance.seaRuntime?.sha256 !== report.manifests?.releaseWindowsNsisManifest?.runtime?.executable?.sha256 ||
      provenance.seaRuntime?.bytes !== report.manifests?.releaseWindowsNsisManifest?.runtime?.executable?.bytes) {
    throw new Error('combined release staging 的 Windows provenance SEA 身份与 manifest 不一致')
  }

  for (const [key, artifactKind] of [
    ['releaseWindowsNsisManifest', 'nsis-installer'],
    ['releaseWindowsInstalledTreeManifest', 'windows-installed-tree'],
    ['releasePortableManifest', 'windows-portable'],
  ]) {
    const summary = report.manifests?.[key]
    const runtime = summary?.runtime
    if (summary?.status !== 'present' || summary.schemaVersion !== 6 || summary.artifactKind !== artifactKind ||
        runtime?.format !== 'sea' || runtime.platform !== 'win32-x64' || runtime.provisional !== false ||
        runtime.sourceInputSha256 !== windowsSourceInputSha256 ||
        runtime.artifactSourceCommit !== provenance.artifactSourceCommit ||
        runtime.executable?.sha256 !== provenance.seaRuntime.sha256 ||
        runtime.executable?.bytes !== provenance.seaRuntime.bytes) {
      throw new Error(`combined release staging 的 Windows ${artifactKind} manifest 与 provenance/source digest 不一致`)
    }
  }

  for (const [assetLabel, metric, label] of [
    ['windows-nsis', report.assets?.windowsInstaller, 'Windows NSIS'],
    ['windows-portable', report.assets?.windowsPortable?.archive, 'Windows portable ZIP'],
  ]) {
    const asset = presentAsset(assets, assetLabel)
    const expectedBasenames = assetLabel === 'windows-nsis'
      ? [asset.asset, asset.asset.replace(/^DeepShell\.Agent_/, 'DeepShell Agent_')]
      : [asset.asset]
    const provenanceArtifact = artifactForAsset(provenance, asset, expectedBasenames)
    if (!provenanceArtifact ||
        provenanceArtifact.sha256 !== asset.sha256 || provenanceArtifact.bytes !== asset.bytes ||
        metric?.sha256 !== asset.sha256 || metric?.bytes !== asset.bytes) {
      throw new Error(`combined release staging 的 ${label} 资产与 Windows provenance/package report 不一致`)
    }
  }
}

async function validateMacosCombinedIdentity(report) {
  const macosSourceInputSha256 = await platformInputDigest(root, 'darwin-arm64')
  const runtime = report.runtime
  if (runtime?.format !== 'sea' || runtime.platform !== 'darwin-arm64' ||
      runtime.provisional !== false || runtime.sourceInputSha256 !== macosSourceInputSha256) {
    throw new Error('combined release staging 的 macOS package report source input digest 已过期')
  }
  await assertCommitIsHeadAncestor(runtime.artifactSourceCommit, 'macOS artifactSourceCommit')
  for (const [key, artifactKind] of [
    ['releasePackageManifest', 'macos-app'],
    ['releaseDmgManifest', 'macos-dmg'],
  ]) {
    const summary = report.manifests?.[key]
    const manifestRuntime = summary?.runtime
    if (summary?.status !== 'present' || summary.schemaVersion !== 6 || summary.artifactKind !== artifactKind ||
        manifestRuntime?.format !== 'sea' || manifestRuntime.platform !== 'darwin-arm64' ||
        manifestRuntime.provisional !== false ||
        manifestRuntime.sourceInputSha256 !== macosSourceInputSha256 ||
        manifestRuntime.artifactSourceCommit !== runtime.artifactSourceCommit ||
        manifestRuntime.executable?.sha256 !== runtime.executable?.sha256 ||
        manifestRuntime.executable?.bytes !== runtime.executable?.bytes) {
      throw new Error(`combined release staging 的 macOS ${artifactKind} manifest 与 package report 不一致`)
    }
  }
}

async function validateCombinedPackageReport(report, assets) {
  if (report?.schemaVersion !== 3) {
    throw new Error('combined release staging 要求 schemaVersion=3 的 package report')
  }
  // 门槛例外（D-1507/D-1508）：report 必须显式记录 gateExceptions 数组（无例外时为空），
  // 使任何被放行的失败项都可从 report 审计；例外本身不阻断 combined staging。
  if (!Array.isArray(report.runtimeAcceptance?.gateExceptions)) {
    throw new Error('combined release staging 要求 package report 记录 gateExceptions 数组')
  }
  if (report.runtime?.provisional !== false || report.runtimeAcceptance?.status !== 'present' ||
      report.runtimeAcceptance?.passed !== true) {
    throw new Error('combined release staging 要求非 provisional Runtime 和已通过的 Runtime acceptance')
  }
  if (report.firstRunFootprint?.status !== 'present' ||
      !Number.isSafeInteger(report.firstRunFootprint.total?.files) ||
      !Number.isSafeInteger(report.firstRunFootprint.total?.bytes)) {
    throw new Error('combined release staging 要求完整的首次运行总占用汇总')
  }
  const dmg = assertPackageReportMetric(report, ['assets', 'dmg'], 'assets.dmg')
  assertPackageReportMetric(report, ['assets', 'app'], 'assets.app')
  const windowsInstaller = assertPackageReportMetric(report, ['assets', 'windowsInstaller'], 'assets.windowsInstaller')
  assertPackageReportMetric(report, ['assets', 'windowsInstalledTree'], 'assets.windowsInstalledTree')
  const windowsPortable = assertPackageReportMetric(report, ['assets', 'windowsPortable'], 'assets.windowsPortable')
  const windowsPortableArchive = assertPackageReportMetric(report, ['assets', 'windowsPortable', 'archive'], 'assets.windowsPortable.archive')
  assertPackageReportSummary(report, 'releasePackageManifest')
  assertPackageReportSummary(report, 'releaseDmgManifest')
  assertPackageReportSummary(report, 'releaseWindowsNsisManifest')
  assertPackageReportSummary(report, 'releaseWindowsInstalledTreeManifest')
  assertPackageReportSummary(report, 'releasePortableManifest')
  assertReportFileMetricMatchesAsset(dmg, presentAsset(assets, 'macos-dmg'), 'DMG')
  assertReportFileMetricMatchesAsset(windowsInstaller, presentAsset(assets, 'windows-nsis'), 'Windows NSIS')
  assertReportFileMetricMatchesAsset(windowsPortableArchive, presentAsset(assets, 'windows-portable'), 'Windows portable ZIP')
  if (windowsPortable.archive?.status !== 'present') {
    throw new Error('combined release staging 的 package report 缺少 present portable archive 指标')
  }
  await validateMacosCombinedIdentity(report)
}

export async function replaceDirectory(stagingDirectory, outputDirectory, fs = { exists, rename, rm }) {
  const backupDirectory = resolve(dirname(outputDirectory), `.${basename(outputDirectory)}-previous-${process.pid}-${Date.now()}`)
  let movedExistingOutput = false
  try {
    if (await fs.exists(outputDirectory)) {
      await fs.rename(outputDirectory, backupDirectory)
      movedExistingOutput = true
    }
    await fs.rename(stagingDirectory, outputDirectory)
    if (movedExistingOutput) {
      try {
        await fs.rm(backupDirectory, { recursive: true, force: true })
      } catch (error) {
        try {
          await fs.rm(backupDirectory, { recursive: true, force: true })
        } catch (retryError) {
          console.warn(`release staging backup cleanup failed; committed output retained; backup may need manual cleanup: ${backupDirectory}: ${retryError?.message ?? error?.message ?? retryError}`)
        }
      }
    }
  } catch (error) {
    if (movedExistingOutput && !await fs.exists(outputDirectory)) {
      try {
        await fs.rename(backupDirectory, outputDirectory)
      } catch {
        // 保留原始异常，避免把真正的 staging 失败原因掩盖掉。
      }
    }
    throw error
  }
}

async function writeReleaseStaging(version, outputDirectory, stagingDirectory, options = {}) {
  const assets = []
  if (options.validateCombinedPackageReport) {
    for (const option of ['--windows-installer', '--windows-portable']) {
      assertExplicitCombinedInput(option)
    }
  }
  const dmgArg = argValue('--dmg', undefined)
  const dmg = dmgArg === undefined ? await currentDmg(version) : { status: 'present', path: resolve(dmgArg) }
  const windowsInstallerArg = argValue('--windows-installer', undefined)
  const windowsInstaller = windowsInstallerArg === undefined
    ? await currentWindowsInstaller(version)
    : { status: 'present', path: resolve(windowsInstallerArg) }
  const windowsPortableArg = argValue('--windows-portable', undefined)
  const windowsPortable = windowsPortableArg === undefined
    ? await currentWindowsPortable(version)
    : { status: 'present', path: resolve(windowsPortableArg) }
  if (dmg.status === 'missing') {
    assets.push({ label: 'macos-dmg', status: 'missing', asset: `DeepShell.Agent_${version}_aarch64.dmg` })
  } else {
    assertArtifactNameMatchesVersion(basename(dmg.path), version, 'macOS DMG', isMacosDmgName)
    const target = resolve(stagingDirectory, `DeepShell.Agent_${version}_aarch64.dmg`)
    await copyFile(dmg.path, target)
    assets.push({ label: 'macos-dmg', status: 'present', asset: basename(target), bytes: (await stat(target)).size, sha256: await sha256(target) })
  }
  if (windowsInstaller.status === 'missing') {
    assets.push({ label: 'windows-nsis', status: 'missing', asset: `DeepShell.Agent_${version}_x64-setup.exe` })
  } else {
    assertArtifactNameMatchesVersion(basename(windowsInstaller.path), version, 'Windows installer', isWindowsNsisInstallerName)
    const target = resolve(stagingDirectory, `DeepShell.Agent_${version}_x64-setup.exe`)
    await copyFile(windowsInstaller.path, target)
    assets.push({ label: 'windows-nsis', status: 'present', asset: basename(target), bytes: (await stat(target)).size, sha256: await sha256(target) })
  }
  if (windowsPortable.status === 'missing') {
    assets.push({ label: 'windows-portable', status: 'missing', asset: `DeepShell.Agent_${version}_x64-portable.zip` })
  } else {
    assertArtifactNameMatchesVersion(basename(windowsPortable.path), version, 'Windows portable ZIP', isWindowsPortableZipName)
    const target = resolve(stagingDirectory, `DeepShell.Agent_${version}_x64-portable.zip`)
    await copyFile(windowsPortable.path, target)
    assets.push({ label: 'windows-portable', status: 'present', asset: basename(target), bytes: (await stat(target)).size, sha256: await sha256(target) })
  }
  const licenseInventory = await copyJsonIfPresent(
    resolve(argValue('--license-inventory', resolve(root, 'runtime/staging/license-inventory.json'))),
    resolve(stagingDirectory, `deepshell-agent-v${version}-license-inventory.json`),
    assets,
    'license-inventory',
    version
  )
  const sbom = await copyJsonIfPresent(
    resolve(argValue('--sbom', resolve(root, 'runtime/staging/sbom.json'))),
    resolve(stagingDirectory, `deepshell-agent-v${version}-sbom.json`),
    assets,
    'sbom',
    version
  )
  const packageReport = await copyJsonIfPresent(
    resolve(argValue('--package-report', resolve(root, 'runtime/staging/package-report.json'))),
    resolve(stagingDirectory, `deepshell-agent-v${version}-package-report.json`),
    assets,
    'package-report',
    version
  )
  const securityAudit = await copyJsonIfPresent(
    resolve(argValue('--security-audit', resolve(root, 'runtime/staging/security-audit.json'))),
    resolve(stagingDirectory, `deepshell-agent-v${version}-security-audit.json`),
    assets,
    'security-audit',
    version
  )
  const windowsProvenance = options.requireWindowsProvenance || hasArg('--windows-provenance')
    ? await copyJsonIfPresent(
      resolve(argValue('--windows-provenance', resolve(root, 'runtime/staging/windows-provenance.json'))),
      resolve(stagingDirectory, `deepshell-agent-v${version}-windows-provenance.json`),
      assets,
      'windows-provenance',
      version
    )
    : null
  const windowsLicenseInventory = options.requireWindowsProvenance || hasArg('--windows-license-inventory')
    ? await copyJsonIfPresent(
      resolve(argValue('--windows-license-inventory', resolve(root, 'runtime/staging/windows-license-inventory.json'))),
      resolve(stagingDirectory, `deepshell-agent-v${version}-windows-license-inventory.json`),
      assets,
      'windows-license-inventory',
      version
    )
    : null
  const windowsSbom = options.requireWindowsProvenance || hasArg('--windows-sbom')
    ? await copyJsonIfPresent(
      resolve(argValue('--windows-sbom', resolve(root, 'runtime/staging/windows-sbom.json'))),
      resolve(stagingDirectory, `deepshell-agent-v${version}-windows-sbom.json`),
      assets,
      'windows-sbom',
      version
    )
    : null
  const windowsSecurityAudit = options.requireWindowsProvenance || hasArg('--windows-security-audit')
    ? await copyJsonIfPresent(
      resolve(argValue('--windows-security-audit', resolve(root, 'runtime/staging/windows-security-audit.json'))),
      resolve(stagingDirectory, `deepshell-agent-v${version}-windows-security-audit.json`),
      assets,
      'windows-security-audit',
      version
    )
    : null
  let windowsReleaseMetadata = {
    notesLine: windowsNotesLine(version),
    manifestFields: windowsManifestFields(version),
  }
  if (options.validateCombinedPackageReport) {
    for (const option of ['--windows-provenance', '--windows-license-inventory', '--windows-sbom', '--windows-security-audit']) {
      assertExplicitCombinedInput(option)
    }
    await validateCombinedPackageReport(packageReport, assets)
    const macIdentity = expectedIdentityFromRuntime(packageReport.runtime, version, 'macOS package report')
    const windowsIdentity = expectedIdentityFromRuntime(
      packageReport.manifests?.releaseWindowsNsisManifest?.runtime,
      version,
      'Windows package report',
    )
    await validateSupportEvidenceGroup({
      licenseInventory,
      sbom,
      securityAudit,
    }, macIdentity, 'macOS')
    await validateWindowsProvenance(windowsProvenance, packageReport, assets, version)
    windowsReleaseMetadata = windowsReleaseMetadataFromProvenance(version, windowsProvenance)
    await validateSupportEvidenceGroup({
      licenseInventory: windowsLicenseInventory,
      sbom: windowsSbom,
      securityAudit: windowsSecurityAudit,
    }, windowsIdentity, 'Windows')
  }

  const presentAssets = assets.filter(asset => asset.status === 'present')
  const sums = presentAssets.map(asset => `${asset.sha256}  ${asset.asset}`).join('\n')
  await writeFile(resolve(stagingDirectory, 'SHA256SUMS.txt'), sums.length === 0 ? '' : `${sums}\n`)

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
    windowsReleaseMetadata.notesLine,
    '',
    '## Assets',
    '',
    ...assets.map(asset => `- ${asset.asset}: ${asset.status}`),
    ''
  ]
  await writeFile(resolve(stagingDirectory, 'RELEASE_NOTES.md'), notes.join('\n'))
  await writeFile(resolve(stagingDirectory, 'release-manifest.json'), redactedJson({
    schemaVersion: 1,
    application: { name: 'DeepShell Agent', version },
    generatedAt: new Date().toISOString(),
    assets,
    publishPolicy: 'local staging only; GitHub release creation and asset upload require explicit user authorization',
    // 草稿模式从静态版本登记读取 Windows 验收事实；最终 combined 模式从已校验 provenance 读取。
    // 两种模式均让 notes 与 manifest 共用同一事实，避免验收状态与轮次自相矛盾。
    ...windowsReleaseMetadata.manifestFields
  }))
  return assets
}

export async function runReleaseStaging() {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const version = argValue('--version', pkg.version)
  const outputDirectory = resolve(argValue('--output-dir', resolve(root, 'runtime/staging', `release-v${version}`)))
  // `--require-assets macos-dmg,windows-nsis,windows-portable`：combined release staging
  // 必须齐全的场景（macOS 收口）用它在替换 output 之前显式失败。
  const requiredAssets = (argValue('--require-assets', '') || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
  for (const option of [
    '--dmg',
    '--windows-installer',
    '--windows-portable',
    '--license-inventory',
    '--sbom',
    '--package-report',
    '--security-audit',
    '--windows-provenance',
    '--windows-license-inventory',
    '--windows-sbom',
    '--windows-security-audit',
  ]) {
    assertExplicitInputOutsideOutput(option, outputDirectory)
  }
  await assertOutputDirectoryMayBeReplaced(version, outputDirectory)
  await mkdir(dirname(outputDirectory), { recursive: true })
  let stagingDirectory = await mkdtemp(resolve(dirname(outputDirectory), `.${basename(outputDirectory)}-tmp-`))
  try {
    const combinedPackageReportRequired = ['macos-dmg', 'windows-nsis', 'windows-portable']
      .every(label => requiredAssets.includes(label))
    const assets = await writeReleaseStaging(version, outputDirectory, stagingDirectory, {
      validateCombinedPackageReport: combinedPackageReportRequired,
      requireWindowsProvenance: combinedPackageReportRequired,
    })
    for (const label of requiredAssets) {
      const asset = assets.find(item => item.label === label)
      if (!asset || asset.status !== 'present') {
        throw new Error(`release staging 要求 ${label} 资产存在，但状态为 ${asset?.status ?? 'missing'}`)
      }
    }
    await replaceDirectory(stagingDirectory, outputDirectory)
    stagingDirectory = null
  } finally {
    if (stagingDirectory) await rm(stagingDirectory, { recursive: true, force: true })
  }

  console.log(`release staging written: ${outputDirectory}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runReleaseStaging()
}
