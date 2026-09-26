import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { parseTargetArg, readLock, root, sha256 } from './lib/runtime.mjs'
import { platformInputDigest } from './lib/source-inputs.mjs'
import {
  generateSeaInventories,
  gitHeadAndDirty,
  inventoryReceipt,
  applySeaCompatibilityTransforms,
  runPackager,
  seaRuntimeFinalizedAtPrepare,
  seaRuntimePaths,
  seaTarget,
  seedIsolatedSeaArchive,
  stageRipgrepSidecar,
  stageSeaInput,
  verifyPackagerPatch,
  writeFileTransactionally,
  writeSeaRuntimeManifest,
} from './lib/sea-runtime.mjs'

const target = parseTargetArg()
if (target === 'all') throw new Error('SEA executable 必须按宿主平台单独构建，不能使用 --target all')
const lock = await readLock()
const exactTarget = seaTarget(lock, target)
const paths = seaRuntimePaths(target)
const buildRoot = resolve(root, 'runtime/staging/sea-build', target)
const isolatedHome = resolve(buildRoot, 'home')
const inputRoot = resolve(buildRoot, 'input')
const input = resolve(inputRoot, 'package.json')
const packagerPatch = await verifyPackagerPatch(lock)
await rm(buildRoot, { recursive: true, force: true })
await mkdir(buildRoot, { recursive: true })
const archive = await seedIsolatedSeaArchive(lock, target, isolatedHome)
const excludedForeignArtifacts = await stageSeaInput(target, inputRoot)
const compatibilityTransforms = await applySeaCompatibilityTransforms(inputRoot)
if (JSON.stringify(lock.sea.transforms) !== JSON.stringify(compatibilityTransforms)) {
  throw new Error('SEA compatibility transforms 与 runtime lock 不一致')
}
await Promise.all([
  copyFile(resolve(root, 'runtime/manifest/sea-entry.mjs'), resolve(inputRoot, 'sea-entry.mjs')),
  copyFile(resolve(root, 'runtime/manifest/sea-probe-worker.mjs'), resolve(inputRoot, 'sea-probe-worker.mjs')),
  copyFile(resolve(root, 'runtime/manifest/sea-probe-argv.mjs'), resolve(inputRoot, 'sea-probe-argv.mjs')),
])
const inventories = await generateSeaInventories(target, paths.directory, inputRoot)

const packageDocument = {
  name: 'deepshell-agent-sea-runtime',
  version: lock.applicationVersion,
  private: true,
  bin: 'sea-entry.mjs',
  pkg: {
    scripts: ['node_modules/**/*.js', 'node_modules/**/*.cjs', 'node_modules/**/*.mjs'],
    assets: ['node_modules/**/*'],
    compress: lock.sea.compression,
    targets: [exactTarget],
    seaConfig: { useSnapshot: false, useCodeCache: false },
  },
}
await writeFile(input, `${JSON.stringify(packageDocument, null, 2)}\n`)
const packagerOutput = await runPackager({ lock, target, input, output: paths.executable, isolatedHome })
// search 工具（glob/grep）在 packaged 模式下需要 `<executable>-rg[.exe]` sidecar
// （native helper 无法从 pkg 的 VFS spawn）；从锁定 production tree 复制并记录摘要。
const ripgrepSidecar = await stageRipgrepSidecar(target, paths.executable)
if (await sha256(archive.path) !== archive.sha256) throw new Error('SEA 构建后 Node 基础归档摘要发生变化')
const pkgManifest = JSON.parse(await readFile(resolve(root, 'node_modules/@yao-pkg/pkg/package.json'), 'utf8'))
if (pkgManifest.version !== lock.sea.packager.version) throw new Error('实际 packager 版本与 runtime lock 不一致')
const sourceInputSha256 = await platformInputDigest(root, target)
const git = await gitHeadAndDirty()
const receipt = {
  schemaVersion: 1,
  runtimeFormat: 'enhanced-sea',
  applicationVersion: lock.applicationVersion,
  platform: target,
  provisional: git.provisional,
  artifactSourceCommit: git.head,
  sourceInputSha256,
  dsh: {
    package: lock.dsh.package,
    version: lock.dsh.version,
    integrity: lock.dsh.integrity,
    patches: lock.dsh.patches,
  },
  node: {
    version: lock.node.version,
    target: exactTarget,
    resolvedVersion: lock.node.version,
    archive: { basename: archive.basename, bytes: archive.bytes, sha256: archive.sha256 },
  },
  packager: {
    package: lock.sea.packager.package,
    version: lock.sea.packager.version,
    integrity: lock.sea.packager.integrity,
    patch: packagerPatch,
    mode: lock.sea.mode,
    compression: lock.sea.compression,
    useSnapshot: lock.sea.useSnapshot,
  },
  packagerOutput: { asset: paths.executable.split('/').at(-1), ...packagerOutput, packagerOutputSha256: packagerOutput.sha256 },
  ripgrepSidecar,
  inventories: {
    native: inventoryReceipt(inventories.native, 'native-addons.json'),
    scripts: inventoryReceipt(inventories.scripts, 'scripts-inventory.json'),
    assets: inventoryReceipt(inventories.assets, 'assets-inventory.json'),
  },
  excludedForeignArtifacts: excludedForeignArtifacts.map(entry => entry.path),
  compatibilityTransforms,
}
delete receipt.packagerOutput.sha256
await writeFileTransactionally(paths.receipt, `${JSON.stringify(receipt, null, 2)}\n`)
// Windows preview 不会在打包阶段改写或签名 SEA executable，因此 prepare 后的摘要已经是
// 最终包摘要；macOS 仍需等待嵌套 codesign 完成后由 sign-package 最终化。
await writeSeaRuntimeManifest(paths, receipt, seaRuntimeFinalizedAtPrepare(target))
console.log(JSON.stringify({ ok: true, target, executable: paths.executable, bytes: packagerOutput.bytes, sha256: packagerOutput.sha256, provisional: receipt.provisional }))
