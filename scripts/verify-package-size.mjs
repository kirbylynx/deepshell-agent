import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { root } from './lib/runtime.mjs'
import { verifyReducedFile, verifyReducedTree } from './lib/package-size.mjs'
import { platformInputDigest } from './lib/source-inputs.mjs'
import { normalizedTreeManifest } from './lib/tree-manifest.mjs'
import { validatePackageManifestV5 } from './lib/package-manifest.mjs'

const execFileAsync = promisify(execFile)
const EXPECTED_V013_COMMIT = 'ca4add9dc52c5053278570abb28e1d21ae5a0239'

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function inspection(manifest, subject, inspectionMode) {
  const value = manifest.inspections?.find(item => item.subject === subject)
  if (!value) throw new Error(`${manifest.artifactKind} 清单缺少 ${subject} inspection`)
  if (value.inspectionMode !== inspectionMode || !value.size || !Array.isArray(value.resources) || !Array.isArray(value.runtimePlatforms)) {
    throw new Error(`${subject} inspection 不符合 schema 5 契约`)
  }
  return value
}

const baseline = await readJson(resolve(root, 'tests/fixtures/package-size-baselines/v0.1.3.json'))
const { stdout: liveV013Commit } = await execFileAsync('git', ['rev-parse', 'v0.1.3^{commit}'], { cwd: root })
if (liveV013Commit.trim() !== EXPECTED_V013_COMMIT) {
  throw new Error(`v0.1.3 tag commit 不正确：expected ${EXPECTED_V013_COMMIT}, got ${liveV013Commit.trim()}`)
}
if (baseline.canonicalSource?.peeledCommit !== EXPECTED_V013_COMMIT) {
  throw new Error('v0.1.3 baseline peeled commit 不正确')
}

if (process.platform === 'darwin') {
  const [appManifest, dmgManifest] = await Promise.all([
    readJson(resolve(root, 'runtime/staging/package-release-darwin-arm64-macos-app.json')),
    readJson(resolve(root, 'runtime/staging/package-release-darwin-arm64-macos-dmg.json')),
  ])
  validatePackageManifestV5(appManifest)
  validatePackageManifestV5(dmgManifest)
  const currentSourceInput = await platformInputDigest(root, 'darwin-arm64')
  for (const manifest of [appManifest, dmgManifest]) {
    if (manifest.schemaVersion !== 5 || manifest.platform !== 'darwin-arm64') {
      throw new Error('macOS size gate 要求当前平台的 schemaVersion 5 manifest')
    }
    if (manifest.macosSourceInputSha256 !== currentSourceInput) {
      throw new Error(`${manifest.artifactKind} manifest 已与当前 macOS 构建输入不同，必须重建`)
    }
  }
  if (appManifest.mode !== 'release' || appManifest.artifactKind !== 'macos-app' ||
      dmgManifest.mode !== 'release' || dmgManifest.artifactKind !== 'macos-dmg') {
    throw new Error('macOS size gate 收到了错误 mode 或 artifactKind 的 manifest')
  }
  const app = inspection(appManifest, 'macos-app', 'exact-artifact-tree')
  const dmg = inspection(dmgManifest, 'macos-dmg', 'file-metadata-only')
  const dmgContainedApp = inspection(dmgManifest, 'dmg-contained-app', 'archive-extracted-tree')
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const appPath = resolve(root, 'src-tauri/target/release/bundle/macos/DeepShell Agent.app')
  const dmgPath = resolve(root, 'src-tauri/target/release/bundle/dmg', `DeepShell Agent_${pkg.version}_aarch64.dmg`)
  const [actualApp, dmgContent, dmgMetadata] = await Promise.all([
    normalizedTreeManifest(appPath),
    readFile(dmgPath),
    stat(dmgPath),
  ])
  if (app.contentSha256 !== actualApp.contentSha256 || app.size.bytes !== actualApp.bytes || app.size.files !== actualApp.files) {
    throw new Error('macos-app manifest 与当前 .app 产物不一致，必须重建')
  }
  const actualDmgSha256 = createHash('sha256').update(dmgContent).digest('hex')
  if (dmg.sha256 !== actualDmgSha256 || dmg.size.bytes !== dmgMetadata.size || dmg.size.files !== 1) {
    throw new Error('macos-dmg manifest 与当前 DMG 产物不一致，必须重建')
  }
  if (dmgContainedApp.contentSha256 !== actualApp.contentSha256 ||
      dmgContainedApp.size.bytes !== actualApp.bytes || dmgContainedApp.size.files !== actualApp.files) {
    throw new Error('DMG manifest 未绑定当前 .app 内容')
  }
  if (appManifest.baseline?.status !== 'canonical' || dmgManifest.baseline?.status !== 'canonical' ||
      appManifest.baseline?.canonicalSourceCommit !== baseline.canonicalSource.peeledCommit ||
      dmgManifest.baseline?.canonicalSourceCommit !== baseline.canonicalSource.peeledCommit) {
    throw new Error('manifest baseline 来源与 tracked fixture 不一致')
  }
  const foreignRuntime = appManifest.resources.some(record => record.path.startsWith('runtime/node/win32-x64/'))
  if (foreignRuntime) throw new Error('macOS 产物包含 win32-x64 Runtime')
  const result = {
    ok: true,
    platform: 'darwin-arm64',
    macosApp: verifyReducedTree({ status: app.status, ...app.size }, baseline.artifacts.macosApp, 'macOS app'),
    macosDmg: verifyReducedFile({ status: dmg.status, ...dmg.size }, baseline.artifacts.macosDmg, 'macOS DMG'),
  }
  console.log(JSON.stringify(result))
} else if (process.platform === 'win32') {
  const [installedTreeManifest, nsisManifest, portableManifest] = await Promise.all([
    readJson(resolve(root, 'runtime/staging/package-release-win32-x64-windows-installed-tree.json')),
    readJson(resolve(root, 'runtime/staging/package-release-win32-x64-nsis-installer.json')),
    readJson(resolve(root, 'runtime/staging/package-release-win32-x64-windows-portable.json')),
  ])
  validatePackageManifestV5(installedTreeManifest)
  validatePackageManifestV5(nsisManifest)
  validatePackageManifestV5(portableManifest)
  const currentSourceInput = await platformInputDigest(root, 'win32-x64')
  for (const manifest of [installedTreeManifest, nsisManifest, portableManifest]) {
    if (manifest.platform !== 'win32-x64') {
      throw new Error('Windows size gate 要求当前平台的 schemaVersion 5 manifest')
    }
    if (manifest.windowsSourceInputSha256 !== currentSourceInput) {
      throw new Error(`${manifest.artifactKind} manifest 已与当前 Windows 构建输入不同，必须重建`)
    }
    if (manifest.mode !== 'release') {
      throw new Error(`Windows size gate 收到了错误 mode：${manifest.mode}`)
    }
  }
  if (installedTreeManifest.artifactKind !== 'windows-installed-tree' ||
      nsisManifest.artifactKind !== 'nsis-installer' ||
      portableManifest.artifactKind !== 'windows-portable') {
    throw new Error('Windows size gate 收到了错误的 artifactKind')
  }
  const installedTree = inspection(installedTreeManifest, 'windows-installed-tree', 'exact-installed-tree')
  inspection(installedTreeManifest, 'runtime-node', 'exact-artifact-tree')
  inspection(installedTreeManifest, 'runtime-dsh', 'exact-artifact-tree')
  inspection(installedTreeManifest, 'profile-template', 'exact-artifact-tree')
  const nsis = inspection(nsisManifest, 'nsis-installer', 'file-metadata-only')
  // portable 为首版：只校验结构与 staging/extracted 一致性，不与 v0.1.3 比较（REQ-1408）。
  const portableStaging = inspection(portableManifest, 'staging', 'exact-artifact-tree')
  const portableArchive = inspection(portableManifest, 'archive', 'file-metadata-only')
  const portableExtracted = inspection(portableManifest, 'extracted', 'archive-extracted-tree')
  if (portableStaging.contentSha256 !== portableExtracted.contentSha256 ||
      portableStaging.size.bytes !== portableExtracted.size.bytes ||
      portableStaging.size.files !== portableExtracted.size.files) {
    throw new Error('portable staging 与 extracted 清单不一致，必须重建')
  }

  // 可选一致性核对：传入实际安装树路径时，重新测量并要求与 manifest 完全一致
  // （防止清单过期；不传则只做 manifest-vs-baseline 门禁）。
  const installedTreeIndex = process.argv.indexOf('--installed-tree')
  const installedTreePath = installedTreeIndex >= 0 ? resolve(process.argv[installedTreeIndex + 1]) : null
  if (installedTreePath !== null) {
    const actual = await normalizedTreeManifest(installedTreePath)
    if (installedTree.contentSha256 !== actual.contentSha256 ||
        installedTree.size.bytes !== actual.bytes || installedTree.size.files !== actual.files) {
      throw new Error('windows-installed-tree manifest 与当前安装树不一致，必须重建')
    }
  }

  const platformMatch = path => path.match(/(^|\/)runtime\/node\/([^/]+)(\/|$)/)
  const foreignRuntimePaths = new Set()
  for (const manifest of [installedTreeManifest, nsisManifest, portableManifest]) {
    for (const inspectionEntry of manifest.inspections) {
      for (const resource of inspectionEntry.resources) {
        const match = platformMatch(resource.path)
        if (match && match[2] !== 'win32-x64') foreignRuntimePaths.add(resource.path)
      }
    }
  }
  if (foreignRuntimePaths.size > 0) {
    throw new Error(`Windows 产物检测到异平台 Runtime：${[...foreignRuntimePaths].sort().join(', ')}`)
  }

  const result = {
    ok: true,
    platform: 'win32-x64',
    windowsInstalledTree: verifyReducedTree(
      { status: installedTree.status, ...installedTree.size },
      baseline.artifacts.windowsInstalledTree,
      'Windows installed tree',
    ),
    windowsNsis: verifyReducedFile(
      { status: nsis.status, ...nsis.size },
      baseline.artifacts.windowsNsis,
      'Windows NSIS',
    ),
    windowsPortable: {
      status: 'recorded-first-version',
      staging: { bytes: portableStaging.size.bytes, files: portableStaging.size.files, contentSha256: portableStaging.contentSha256 },
      archive: { bytes: portableArchive.size.bytes, sha256: portableArchive.sha256 },
      extracted: { bytes: portableExtracted.size.bytes, files: portableExtracted.size.files, contentSha256: portableExtracted.contentSha256 },
    },
  }
  console.log(JSON.stringify(result))
} else {
  throw new Error(`不支持的 size gate 平台：${process.platform}`)
}
