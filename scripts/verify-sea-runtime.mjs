import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import { parseTargetArg, readLock, root, sha256 } from './lib/runtime.mjs'
import { platformInputDigest } from './lib/source-inputs.mjs'
import { inventoryContentSha256, readSeaReceipt, seaRuntimeFinalizedAtPrepare, seaRuntimePaths, seaTarget, verifyPackagerPatch } from './lib/sea-runtime.mjs'

const target = parseTargetArg()
if (target === 'all') throw new Error('SEA verify 必须按平台执行')
const lock = await readLock()
const packagerPatch = await verifyPackagerPatch(lock)
const paths = seaRuntimePaths(target)
const execFileAsync = promisify(execFile)
await Promise.all(Object.values(paths).map(path => access(path)))
const receipt = await readSeaReceipt(paths.receipt)
const runtimeManifest = JSON.parse(await readFile(paths.runtimeManifest, 'utf8'))
for (const [name, value, schemaFile] of [
  ['build receipt', receipt, 'sea-build-receipt.schema.json'],
  ['runtime manifest', runtimeManifest, 'sea-runtime.schema.json'],
]) {
  const schema = JSON.parse(await readFile(resolve(root, 'runtime/manifest', schemaFile), 'utf8'))
  const validate = new Ajv2020({ strict: false }).compile(schema)
  if (!validate(value)) throw new Error(`SEA ${name} schema 无效：${JSON.stringify(validate.errors)}`)
}
if (receipt.schemaVersion !== 1 || receipt.runtimeFormat !== 'enhanced-sea' || receipt.platform !== target) {
  throw new Error('SEA build receipt 基本契约不匹配')
}
if (receipt.applicationVersion !== lock.applicationVersion || receipt.dsh?.version !== lock.dsh.version) {
  throw new Error('SEA build receipt 版本与 runtime lock 不一致')
}
if (JSON.stringify(receipt.dsh?.patches) !== JSON.stringify(lock.dsh.patches)) {
  throw new Error('SEA build receipt 的 DSH patches 与 runtime lock 不一致')
}
if (receipt.sourceInputSha256 !== await platformInputDigest(root, target)) {
  throw new Error('SEA build receipt 的 source input digest 已过期，必须重建')
}
if (receipt.node?.target !== seaTarget(lock, target) || receipt.node?.archive?.sha256 !== lock.node.targets[target].sha256) {
  throw new Error('SEA Node target/archive 与 runtime lock 不一致')
}
if (receipt.packager?.version !== lock.sea.packager.version || receipt.packager?.mode !== 'enhanced'
  || receipt.packager?.patch?.path !== packagerPatch.path || receipt.packager?.patch?.sha256 !== packagerPatch.sha256) {
  throw new Error('SEA packager receipt 与 runtime lock 不一致')
}
if (JSON.stringify(receipt.compatibilityTransforms) !== JSON.stringify(lock.sea.transforms)) {
  throw new Error('SEA compatibility transforms 与 runtime lock 不一致')
}
const executableSha256 = await sha256(paths.executable)
if (receipt.packagerOutput?.packagerOutputSha256 !== executableSha256 || receipt.packagerOutput?.bytes !== (await stat(paths.executable)).size) {
  throw new Error('SEA executable 与 build receipt 不一致')
}
const expectedFinalizedForPackage = seaRuntimeFinalizedAtPrepare(target)
if (runtimeManifest.finalizedForPackage !== expectedFinalizedForPackage
  || runtimeManifest.executable?.sha256 !== executableSha256
  || runtimeManifest.buildReceipt?.sha256 !== await sha256(paths.receipt)
  || runtimeManifest.nativeInventory?.sha256 !== await sha256(paths.nativeInventory)
  || runtimeManifest.dsh?.version !== lock.dsh.version
  || JSON.stringify(runtimeManifest.dsh?.patches) !== JSON.stringify(lock.dsh.patches.map(patch => ({ package: patch.package, version: patch.version, sha256: patch.sha256 })))) {
  throw new Error('SEA runtime manifest 与构建产物不一致')
}
for (const [name, path] of [['native', paths.nativeInventory], ['scripts', paths.scriptsInventory], ['assets', paths.assetsInventory]]) {
  const inventory = JSON.parse(await readFile(path, 'utf8'))
  const inventorySchema = JSON.parse(await readFile(resolve(root, 'runtime/manifest/sea-inventory.schema.json'), 'utf8'))
  const validateInventory = new Ajv2020({ strict: false }).compile(inventorySchema)
  if (!validateInventory(inventory)) throw new Error(`SEA ${name} inventory schema 无效：${JSON.stringify(validateInventory.errors)}`)
  if (inventory.files !== inventory.entries.length
    || inventory.bytes !== inventory.entries.reduce((sum, entry) => sum + entry.bytes, 0)
    || inventory.contentSha256 !== inventoryContentSha256(inventory.entries)) {
    throw new Error(`SEA ${name} inventory 聚合字段与 entries 不一致`)
  }
  if (inventory.target !== target || inventory.contentSha256 !== receipt.inventories[name].contentSha256 || inventory.files !== receipt.inventories[name].files) {
    throw new Error(`SEA ${name} inventory 与 receipt 不一致`)
  }
}
const direntProbe = JSON.parse((await execFileAsync(paths.executable, ['--deepshell-sea-probe', 'dirent'], {
  timeout: 30_000,
  maxBuffer: 1024 * 1024,
})).stdout.trim())
if (direntProbe.ok !== true || !Number.isInteger(direntProbe.embeddedEntries) || direntProbe.embeddedEntries < 1) {
  throw new Error(`SEA readdir Dirent probe 失败：${JSON.stringify(direntProbe)}`)
}

const sessionWorkerProbe = JSON.parse((await execFileAsync(paths.executable, ['--deepshell-sea-probe', 'session-worker'], {
  env: process.env,
  maxBuffer: 10 * 1024 * 1024,
})).stdout.trim())
if (sessionWorkerProbe.ok !== true || sessionWorkerProbe.packaged !== true) {
  throw new Error(`SEA DSH Session Worker probe 失败：${JSON.stringify(sessionWorkerProbe)}`)
}
console.log(JSON.stringify({ ok: true, target, sha256: executableSha256, provisional: receipt.provisional }))
