import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseTargetArg, readLock, root } from './lib/runtime.mjs'
import { isForeignTargetPath, readSeaReceipt, seaRuntimePaths } from './lib/sea-runtime.mjs'
import { normalizedTreeManifest } from './lib/tree-manifest.mjs'
import { platformInputDigest } from './lib/source-inputs.mjs'

const target = parseTargetArg()
if (target === 'all') throw new Error('SEA compare 必须按宿主平台执行')
const lock = await readLock()
const paths = seaRuntimePaths(target)
const staging = resolve(root, 'runtime/staging/sea-build', target, 'input')
const standard = await normalizedTreeManifest(resolve(root, 'runtime/dsh'))
const packed = await normalizedTreeManifest(staging)
const transformed = new Set(['node_modules/node-pty/lib/unixTerminal.js'])
const generated = new Set(['package.json', 'sea-entry.mjs', 'sea-probe-worker.mjs', 'sea-probe-argv.mjs'])
const expected = new Map(standard.entries
  .filter(entry => !isForeignTargetPath(target, entry.path))
  .filter(entry => !transformed.has(entry.path))
  .map(entry => [entry.path, entry]))
const actual = new Map(packed.entries
  .filter(entry => !generated.has(entry.path))
  .filter(entry => !transformed.has(entry.path))
  .map(entry => [entry.path, entry]))

for (const [path, entry] of expected) {
  const candidate = actual.get(path)
  if (!candidate || candidate.bytes !== entry.bytes || candidate.sha256 !== entry.sha256) {
    throw new Error(`SEA staging 与 Standard Runtime 不一致：${path}`)
  }
}
for (const path of actual.keys()) {
  if (!expected.has(path)) throw new Error(`SEA staging 出现未声明额外资源：${path}`)
}
const nodePty = await readFile(resolve(staging, 'node_modules/node-pty/lib/unixTerminal.js'), 'utf8')
if (!nodePty.includes('process.pkgNativePath')) throw new Error('SEA staging 缺少锁定的 node-pty compatibility transform')

const [receipt, profileManifest, dshPackage, bundlePackage] = await Promise.all([
  readSeaReceipt(paths.receipt),
  readFile(resolve(root, 'runtime/profile-template/template-manifest.json'), 'utf8').then(JSON.parse),
  readFile(resolve(root, 'runtime/dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8').then(JSON.parse),
  readFile(resolve(root, 'dsh/bundles/deepshell-desktop/package.json'), 'utf8').then(JSON.parse),
])
if (receipt.sourceInputSha256 !== await platformInputDigest(root, target)) {
  throw new Error('SEA compare 检测到过期 build receipt，必须重建')
}
if (dshPackage.version !== lock.dsh.version || receipt.dsh.version !== lock.dsh.version
  || profileManifest.dshVersion !== lock.dsh.version) {
  throw new Error('Standard/SEA/Profile DSH version 不一致')
}
if (bundlePackage.version !== lock.applicationVersion || profileManifest.desktopBundleVersion !== lock.applicationVersion) {
  throw new Error('Standard/SEA/Profile Bundle version 不一致')
}
const presetIds = Object.keys(profileManifest.agentPresets ?? {})
for (const id of ['deepshell-coding', 'deepshell-work', 'deepshell-general', 'deepshell']) {
  if (!presetIds.includes(id)) throw new Error(`SEA Profile 缺少 Preset：${id}`)
}
console.log(JSON.stringify({
  ok: true,
  target,
  comparedFiles: expected.size,
  excludedForeignArtifacts: receipt.excludedForeignArtifacts.length,
  dshVersion: lock.dsh.version,
  bundleVersion: lock.applicationVersion,
  presetIds,
}))
