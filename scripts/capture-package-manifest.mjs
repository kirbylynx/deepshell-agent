// 捕获按平台、按产物类型隔离的 package manifest（schema 5）。
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
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
const argumentValue = name => {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const installedTreeArgument = argumentValue('--installed-tree')
if (requestedKind === 'windows-installed-tree' && !installedTreeArgument) {
  throw new Error('用法：capture-package-manifest.mjs <e2e|release> windows-installed-tree --installed-tree <path>')
}
const stagingArgument = argumentValue('--staging')
const archiveArgument = argumentValue('--archive')
const extractedArgument = argumentValue('--extracted')
if (requestedKind === 'windows-portable' && (!stagingArgument || !archiveArgument || !extractedArgument)) {
  throw new Error('用法：capture-package-manifest.mjs <e2e|release> windows-portable --staging <path> --archive <path> --extracted <path>')
}

const lock = await readLock()
const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const adapterOptions = requestedKind === 'windows-installed-tree'
  ? { artifactPath: installedTreeArgument }
  : requestedKind === 'windows-portable'
    ? { stagingPath: stagingArgument, archivePath: archiveArgument, extractedPath: extractedArgument }
    : undefined
const adapter = packageAdapter(process.platform, lock, requestedKind, adapterOptions)
await requireArtifactReady(adapter, access)
await access(adapter.resourcesRoot)
await access(adapter.intermediateRoot)

const digest = content => createHash('sha256').update(content).digest('hex')

/// 流式计算文件 sha256：避免把整个安装包（数十 MB）读入内存。
async function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

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
      : artifactKind === 'windows-installed-tree'
        ? baselineFixture.artifacts.windowsInstalledTree
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
    const artifactSha256 = await hashFile(adapter.artifactPath)
    const artifactBytes = (await stat(adapter.artifactPath)).size
    const containedApp = await verifyDmgContainsApp(adapter.artifactPath, appRoot)
    inspections.push({
      subject: 'macos-dmg',
      inspectionMode: 'file-metadata-only',
      status: 'present',
      resources: [{ path: basename(adapter.artifactPath), bytes: artifactBytes, sha256: artifactSha256 }],
      runtimePlatforms: [],
      size: { bytes: artifactBytes, files: 1 },
      sha256: artifactSha256,
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
  const artifactSha256 = await hashFile(adapter.artifactPath)
  const artifactBytes = (await stat(adapter.artifactPath)).size
  inspections.push({
    subject: 'nsis-installer',
    inspectionMode: 'file-metadata-only',
    status: 'present',
    resources: [{ path: basename(adapter.artifactPath), bytes: artifactBytes, sha256: artifactSha256 }],
    runtimePlatforms: [],
    runtimeInspectionStatus: 'unverified-until-installed-tree-inspection',
    size: { bytes: artifactBytes, files: 1 },
    sha256: artifactSha256,
  })
} else if (adapter.artifactKind === 'windows-installed-tree') {
  // 安装树是唯一可遍历证明 NSIS 内容的 subject（设计 §4.3/§4.4）：
  // Runtime/DSH/Profile 子树必须与经过 runtime:verify/profile:verify 的源子树逐项等价。
  const tree = adapter.primaryTreePath
  const mappings = [
    ['runtime-node', resolve(root, 'runtime/node/win32-x64'), resolve(tree, 'runtime/node/win32-x64'), ['win32-x64']],
    ['runtime-dsh', resolve(root, 'runtime/dsh'), resolve(tree, 'runtime/dsh'), []],
    ['profile-template', resolve(root, 'runtime/profile-template'), resolve(tree, 'runtime/profile-template'), []],
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
  const treeManifest = await normalizedTreeManifest(tree)
  const platformMatch = path => path.match(/(^|\/)runtime\/node\/([^/]+)(\/|$)/)
  const foreignRuntime = treeManifest.entries.find(entry => {
    const match = platformMatch(entry.path)
    return match !== null && match[2] !== 'win32-x64'
  })
  if (foreignRuntime) throw new Error(`Windows installed tree 包含异平台 Runtime：${foreignRuntime.path}`)
  inspections.push({
    subject: 'windows-installed-tree',
    inspectionMode: 'exact-installed-tree',
    status: 'present',
    resources: treeManifest.entries,
    runtimePlatforms: runtimePlatforms(treeManifest.entries),
    size: { bytes: treeManifest.bytes, files: treeManifest.files },
    contentSha256: treeManifest.contentSha256,
  })
} else if (adapter.artifactKind === 'windows-portable') {
  // 免安装 ZIP：staging 与解压树都必须与已验证源子树等价，且二者互相等价（设计 §4.4）。
  const staging = adapter.primaryTreePath
  const extracted = adapter.extractedPath
  const mappings = [
    ['runtime-node', resolve(root, 'runtime/node/win32-x64'), 'runtime/node/win32-x64', ['win32-x64']],
    ['runtime-dsh', resolve(root, 'runtime/dsh'), 'runtime/dsh', []],
    ['profile-template', resolve(root, 'runtime/profile-template'), 'runtime/profile-template', []],
  ]
  for (const [subject, source, relativePath, subjectRuntimePlatforms] of mappings) {
    const stagingEquivalence = await assertEquivalentTrees(source, resolve(staging, relativePath), `portable staging ${subject}`)
    await assertEquivalentTrees(source, resolve(extracted, relativePath), `portable extracted ${subject}`)
    inspections.push({
      subject,
      inspectionMode: 'exact-artifact-tree',
      status: 'equivalent',
      resources: stagingEquivalence.target.entries,
      runtimePlatforms: subjectRuntimePlatforms,
      size: { bytes: stagingEquivalence.target.bytes, files: stagingEquivalence.target.files },
      contentSha256: stagingEquivalence.target.contentSha256,
    })
  }
  const { source: stagingManifest, target: extractedManifest } = await assertEquivalentTrees(staging, extracted, 'portable staging/extracted')
  const platformMatch = path => path.match(/(^|\/)runtime\/node\/([^/]+)(\/|$)/)
  const foreignRuntime = stagingManifest.entries.find(entry => {
    const match = platformMatch(entry.path)
    return match !== null && match[2] !== 'win32-x64'
  })
  if (foreignRuntime) throw new Error(`Windows portable staging 包含异平台 Runtime：${foreignRuntime.path}`)
  inspections.push({
    subject: 'staging',
    inspectionMode: 'exact-artifact-tree',
    status: 'present',
    resources: stagingManifest.entries,
    runtimePlatforms: runtimePlatforms(stagingManifest.entries),
    size: { bytes: stagingManifest.bytes, files: stagingManifest.files },
    contentSha256: stagingManifest.contentSha256,
  })
  const archiveSha256 = await hashFile(adapter.artifactPath)
  const archiveBytes = (await stat(adapter.artifactPath)).size
  inspections.push({
    subject: 'archive',
    inspectionMode: 'file-metadata-only',
    status: 'present',
    resources: [{ path: basename(adapter.artifactPath), bytes: archiveBytes, sha256: archiveSha256 }],
    runtimePlatforms: [],
    size: { bytes: archiveBytes, files: 1 },
    sha256: archiveSha256,
  })
  inspections.push({
    subject: 'extracted',
    inspectionMode: 'archive-extracted-tree',
    status: 'equivalent',
    resources: extractedManifest.entries,
    runtimePlatforms: runtimePlatforms(extractedManifest.entries),
    size: { bytes: extractedManifest.bytes, files: extractedManifest.files },
    contentSha256: extractedManifest.contentSha256,
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

// installed-tree / portable 的完整资源清单已在 inspections 中按 subject 记录；
// 顶层 resources 再存一份全树（数万条目）会让清单体积翻倍，且没有消费方需要它。
const aggregateOnlyKinds = new Set(['windows-installed-tree', 'windows-portable'])
const artifactResources = aggregateOnlyKinds.has(adapter.artifactKind)
  ? { entries: [] }
  : await normalizedTreeManifest(adapter.intermediateRoot)
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
