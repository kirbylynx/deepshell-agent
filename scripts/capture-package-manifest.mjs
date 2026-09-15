// 捕获按平台、按产物类型隔离的 package manifest（schema 5）。
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import { readLock, root } from './lib/runtime.mjs'
import { platformInputDigest } from './lib/source-inputs.mjs'
import { assertEquivalentTrees, normalizedTreeManifest } from './lib/tree-manifest.mjs'
import { packageAdapter, requireArtifactReady } from './lib/package-platform.mjs'
import { verifyDmgContainsApp } from './lib/macos-dmg.mjs'
import { validatePackageManifestV5 } from './lib/package-manifest.mjs'

const execFileAsync = promisify(execFile)
const mode = process.argv[2]
const requestedKind = process.argv[3]
if (!['e2e', 'release'].includes(mode)) {
  throw new Error('用法：capture-package-manifest.mjs <e2e|release> [artifact-kind]')
}

const lock = await readLock()
const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const adapter = packageAdapter(process.platform, lock, requestedKind)
await requireArtifactReady(adapter, access)
await access(adapter.resourcesRoot)
await access(adapter.intermediateRoot)

const digest = content => createHash('sha256').update(content).digest('hex')

async function readMarkerText() {
  if (adapter.platform === 'darwin') {
    const { stdout } = await execFileAsync('/usr/bin/strings', [adapter.binaryPath], { maxBuffer: 64 * 1024 * 1024 })
    return stdout
  }
  return adapter.readBinaryStrings(adapter.binaryPath)
}

const platformConfig = adapter.platform === 'darwin'
  ? 'src-tauri/tauri.macos.conf.json'
  : 'src-tauri/tauri.windows.conf.json'
const configSources = ['src-tauri/tauri.conf.json', platformConfig]
const featureArgs = mode === 'e2e' ? ['--features', 'poc-e2e'] : []
const [
  markerText,
  { stdout: cargoMetadata },
  { stdout: cargoFeatureTree },
  capability,
  profileManifest,
  cargoToml,
  cargoLock,
  sourceInputSha256,
  ...configs
] = await Promise.all([
  readMarkerText(),
  execFileAsync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1', '--manifest-path', resolve(root, 'src-tauri/Cargo.toml')], { maxBuffer: 64 * 1024 * 1024 }),
  execFileAsync('cargo', ['tree', '--locked', '--manifest-path', resolve(root, 'src-tauri/Cargo.toml'), '-e', 'features', ...featureArgs], { maxBuffer: 64 * 1024 * 1024 }),
  readFile(resolve(root, 'src-tauri/capabilities/main.json')),
  readFile(resolve(adapter.resourcesRoot, 'runtime/profile-template/template-manifest.json')),
  readFile(resolve(root, 'src-tauri/Cargo.toml')),
  readFile(resolve(root, 'src-tauri/Cargo.lock')),
  platformInputDigest(root, adapter.runtimePlatform()),
  ...configSources.map(path => readFile(resolve(root, path))),
])
const configSha256 = digest(Buffer.concat(configs.flatMap((content, index) => [Buffer.from(configSources[index]), Buffer.from([0]), content, Buffer.from([0])])))
const baselineFixture = JSON.parse(await readFile(resolve(root, 'tests/fixtures/package-size-baselines/v0.1.3.json'), 'utf8'))

function runtimePlatforms(resources) {
  const platforms = new Set()
  for (const resource of resources) {
    if (/(^|\/)runtime\/node\/darwin-arm64(\/|$)/.test(resource.path)) platforms.add('darwin-arm64')
    if (/(^|\/)runtime\/node\/win32-x64(\/|$)/.test(resource.path)) platforms.add('win32-x64')
  }
  return [...platforms].sort()
}

function baselineFor(artifactKind) {
  const artifact = artifactKind === 'macos-dmg'
    ? baselineFixture.artifacts.macosDmg
    : artifactKind === 'macos-app'
      ? baselineFixture.artifacts.macosApp
      : artifactKind === 'nsis-installer' ? baselineFixture.artifacts.windowsNsis : null
  return {
    status: artifact?.status ?? 'pending',
    ...(artifact?.reason ? { reason: artifact.reason } : {}),
    canonicalSourceRef: 'v0.1.3',
    canonicalSourceCommit: baselineFixture.canonicalSource.peeledCommit,
    ...(artifact?.sha256 ? { artifactSha256: artifact.sha256 } : {}),
    ...(artifact?.contentSha256 ? { treeContentSha256: artifact.contentSha256 } : {}),
    baselineSourceInputSha256: baselineFixture.canonicalSource.baselineSourceInputSha256,
    algorithmVersion: baselineFixture.measurement.algorithm,
  }
}

const inspections = []
if (adapter.platform === 'darwin') {
  const appRoot = adapter.primaryTreePath
  const appResources = resolve(appRoot, 'Contents/Resources')
  const mappings = [
    ['runtime-node', resolve(root, 'runtime/node/darwin-arm64'), resolve(appResources, 'runtime/node/darwin-arm64'), ['darwin-arm64']],
    ['runtime-dsh', resolve(root, 'runtime/dsh'), resolve(appResources, 'runtime/dsh'), []],
    ['profile-template', resolve(root, 'runtime/profile-template'), resolve(appResources, 'runtime/profile-template'), []],
  ]
  for (const [subject, source, target, subjectRuntimePlatforms] of mappings) {
    const equivalence = await assertEquivalentTrees(source, target, subject)
    inspections.push({
      subject,
      inspectionMode: 'exact-artifact-tree',
      status: 'equivalent',
      resources: equivalence.target.entries,
      runtimePlatforms: subjectRuntimePlatforms,
      size: { bytes: equivalence.target.bytes, files: equivalence.target.files },
      contentSha256: equivalence.target.contentSha256,
    })
  }
  const appTree = await normalizedTreeManifest(appRoot)
  inspections.push({
    subject: 'macos-app',
    inspectionMode: 'exact-artifact-tree',
    status: 'present',
    resources: appTree.entries,
    runtimePlatforms: runtimePlatforms(appTree.entries),
    size: { bytes: appTree.bytes, files: appTree.files },
    contentSha256: appTree.contentSha256,
  })
  if (adapter.artifactKind === 'macos-dmg') {
    const content = await readFile(adapter.artifactPath)
    const containedApp = await verifyDmgContainsApp(adapter.artifactPath, appRoot)
    inspections.push({
      subject: 'macos-dmg',
      inspectionMode: 'file-metadata-only',
      status: 'present',
      resources: [{ path: basename(adapter.artifactPath), bytes: content.length, sha256: digest(content) }],
      runtimePlatforms: [],
      size: { bytes: (await stat(adapter.artifactPath)).size, files: 1 },
      sha256: digest(content),
    })
    inspections.push({
      subject: 'dmg-contained-app',
      inspectionMode: 'archive-extracted-tree',
      status: 'equivalent',
      resources: containedApp.target.entries,
      runtimePlatforms: runtimePlatforms(containedApp.target.entries),
      size: { bytes: containedApp.target.bytes, files: containedApp.target.files },
      contentSha256: containedApp.target.contentSha256,
    })
  }
} else if (adapter.artifactKind === 'nsis-installer') {
  const content = await readFile(adapter.artifactPath)
  inspections.push({
    subject: 'nsis-installer',
    inspectionMode: 'file-metadata-only',
    status: 'present',
    resources: [{ path: basename(adapter.artifactPath), bytes: content.length, sha256: digest(content) }],
    runtimePlatforms: [],
    runtimeInspectionStatus: 'unverified-until-installed-tree-inspection',
    size: { bytes: (await stat(adapter.artifactPath)).size, files: 1 },
    sha256: digest(content),
  })
}

let platformSpecific
if (adapter.platform === 'darwin') {
  const [signing, entitlements, infoPlist, linkedLibraries] = await Promise.all([
    execFileAsync('/usr/bin/codesign', ['-dvvv', adapter.primaryTreePath]).catch(error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' })),
    execFileAsync('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', adapter.binaryPath]).catch(error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' })),
    readFile(resolve(adapter.primaryTreePath, 'Contents/Info.plist')),
    execFileAsync('/usr/bin/otool', ['-L', adapter.binaryPath], { maxBuffer: 4 * 1024 * 1024 }),
  ])
  platformSpecific = {
    infoPlistSha256: digest(infoPlist),
    linkedLibraries: linkedLibraries.stdout.trim().split('\n').slice(1).map(line => line.trim()).sort(),
    signing: {
      adhoc: `${signing.stdout}${signing.stderr}`.includes('Signature=adhoc'),
      identifier: /Identifier=com\.deepshell\.agent/.test(`${signing.stdout}${signing.stderr}`),
      entitlementsSha256: digest(`${entitlements.stdout}${entitlements.stderr}`.replace(/^Executable=.*$/m, '')),
    },
  }
} else {
  platformSpecific = { linkedLibraries: adapter.linkedLibraries, signing: adapter.signing }
}

const artifactResources = await normalizedTreeManifest(adapter.intermediateRoot)
const platformDigestField = adapter.runtimePlatform() === 'darwin-arm64'
  ? 'macosSourceInputSha256'
  : 'windowsSourceInputSha256'
const manifest = {
  schemaVersion: 5,
  platform: adapter.runtimePlatform(),
  applicationVersion: rootPackage.version,
  mode,
  artifactKind: adapter.artifactKind,
  buildProfile: markerText.includes('deepshell-build-profile:poc-e2e')
    ? 'poc-e2e'
    : markerText.includes('deepshell-build-profile:release') ? 'release' : 'unknown',
  configSha256,
  capabilitySha256: digest(capability),
  profileManifestSha256: digest(profileManifest),
  cargoTomlSha256: digest(cargoToml),
  cargoLockSha256: digest(cargoLock),
  cargoMetadataSha256: digest(cargoMetadata),
  cargoFeatureTreeSha256: digest(cargoFeatureTree),
  cargoFeatureTreeHasWebdriver: cargoFeatureTree.includes('tauri-plugin-wdio-webdriver'),
  [platformDigestField]: sourceInputSha256,
  binarySourceInputSha256: sourceInputSha256,
  webdriverMarker: markerText.includes('deepshell-build-profile:poc-e2e'),
  e2eStopCommandMarker: markerText.includes('poc_e2e_stop_runtime'),
  ...platformSpecific,
  configSources,
  baseline: baselineFor(adapter.artifactKind),
  inspections,
  resources: artifactResources.entries,
}
if (!markerText.includes(`deepshell-source-input:${sourceInputSha256}`)) {
  throw new Error('package binary source receipt 与当前平台输入 digest 不一致，必须重建')
}
validatePackageManifestV5(manifest)
if (manifest.buildProfile !== (mode === 'e2e' ? 'poc-e2e' : 'release')) {
  throw new Error(`实际 binary build profile 与 ${mode} 清单不一致`)
}

const outputDirectory = resolve(root, 'runtime/staging')
await mkdir(outputDirectory, { recursive: true })
const canonicalName = `package-${mode}-${manifest.platform}-${manifest.artifactKind}.json`
const serializedManifest = `${JSON.stringify(manifest, null, 2)}\n`
await writeFile(resolve(outputDirectory, canonicalName), serializedManifest)
if ((adapter.platform === 'darwin' && adapter.artifactKind === 'macos-app') ||
    (adapter.platform === 'win32' && adapter.artifactKind === 'nsis-installer')) {
  await writeFile(resolve(outputDirectory, `package-${mode}.json`), serializedManifest)
}
console.log(`${mode} package manifest captured: ${canonicalName} (schemaVersion=5)`)
