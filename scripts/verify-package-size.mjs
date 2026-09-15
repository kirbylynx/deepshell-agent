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
const EXPECTED_V013_COMMIT = '34142a3e78f237b0c494551ffe4a8e309f3ab66a'

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
  if (baseline.artifacts.windowsInstalledTree?.status !== 'canonical') {
    throw new Error('Windows installed-tree baseline 仍为 pending，Windows size gate 必须阻塞')
  }
  throw new Error('Windows size gate 将在 W0/W1 接管 installed-tree 产物后启用')
} else {
  throw new Error(`不支持的 size gate 平台：${process.platform}`)
}
