import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFile, chmod, cp, lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { nodeArchivePath, root, sha256, targetLock } from './runtime.mjs'
import { normalizedTreeManifest } from './tree-manifest.mjs'

const execFileAsync = promisify(execFile)
const executableNames = { 'darwin-arm64': 'deepshell-runtime', 'win32-x64': 'deepshell-runtime.exe' }

export function seaTarget(lock, target) {
  const value = lock.sea?.targets?.[target]
  const platform = target === 'darwin-arm64' ? 'macos-arm64' : target === 'win32-x64' ? 'win-x64' : null
  const expected = platform === null ? null : `node${lock.node.version}-${platform}`
  if (!value || value !== expected || !/^node\d+\.\d+\.\d+-(macos-arm64|win-x64)$/.test(value)) {
    throw new Error(`SEA target 必须与精确 Node 三段版本一致：expected ${expected}, got ${value ?? 'missing'}`)
  }
  return value
}

export function seaRuntimeFinalizedAtPrepare(target) {
  if (!Object.hasOwn(executableNames, target)) throw new Error(`不支持的 SEA target：${target}`)
  return target === 'win32-x64'
}

export function seaRuntimePaths(target) {
  const directory = resolve(root, 'runtime/sea', target)
  return {
    directory,
    executable: resolve(directory, executableNames[target] ?? 'deepshell-runtime'),
    receipt: resolve(directory, 'sea-build-receipt.json'),
    runtimeManifest: resolve(directory, 'sea-runtime-manifest.json'),
    nativeInventory: resolve(directory, 'native-addons.json'),
    scriptsInventory: resolve(directory, 'scripts-inventory.json'),
    assetsInventory: resolve(directory, 'assets-inventory.json'),
  }
}

function portablePath(base, path) {
  return relative(base, path).split(sep).join('/')
}

async function inventory(rootPath, predicate) {
  const tree = await normalizedTreeManifest(rootPath)
  const entries = tree.entries.filter(entry => predicate(entry.path))
  const contentSha256 = inventoryContentSha256(entries)
  return {
    schemaVersion: 1,
    files: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    contentSha256,
    entries,
  }
}

export function inventoryContentSha256(entries) {
  const hash = createHash('sha256')
  for (const entry of entries) {
    hash.update(entry.path)
    hash.update('\0')
    hash.update(String(entry.bytes))
    hash.update('\0')
    hash.update(entry.sha256)
    hash.update('\0')
  }
  return hash.digest('hex')
}

async function pathExists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export async function replaceFileTransactionally(temporary, destination) {
  if (process.platform !== 'win32') {
    await rename(temporary, destination)
    return
  }
  const backup = `${destination}.previous`
  await rm(backup, { force: true })
  const hadDestination = await pathExists(destination)
  if (hadDestination) await rename(destination, backup)
  try {
    await rename(temporary, destination)
    await rm(backup, { force: true })
  } catch (error) {
    if (hadDestination && await pathExists(backup)) await rename(backup, destination)
    throw error
  }
}

export async function writeFileTransactionally(path, content) {
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, content)
  await replaceFileTransactionally(temporary, path)
}

export function isForeignTargetPath(target, path) {
  const normalized = `/${path.replaceAll('\\', '/')}/`
  const nodePtyTarget = normalized.match(/\/node_modules\/node-pty\/prebuilds\/([^/]+)\//i)?.[1]
  if (nodePtyTarget) return nodePtyTarget !== (target === 'darwin-arm64' ? 'darwin-arm64' : 'win32-x64')
  if (normalized.includes('/node_modules/node-pty/third_party/conpty/')) {
    if (target === 'darwin-arm64') return true
    return normalized.includes('/win10-arm64/')
  }
  const platformPackage = normalized.match(/\/node_modules\/(?:@img\/(?:sharp-libvips|sharp)-|@koromix\/koffi-|@deepseek-ai\/node-addon-system-|@vscode\/ripgrep-|node-addon-require-builtin-)([^/]+)\//i)?.[1]
  if (!platformPackage) return false
  // Windows 平台包名可能带工具链后缀（例如 node-addon-require-builtin-win32-x64-msvc），
  // 归一化后比较，避免把本平台包误判为 foreign。
  const normalizedPackage = platformPackage.replace(/-(?:msvc|gnu|musl)$/i, '')
  return normalizedPackage !== (target === 'darwin-arm64' ? 'darwin-arm64' : 'win32-x64')
}

function isForeignNative(target, path) {
  const extension = extname(path).toLowerCase()
  if (target === 'darwin-arm64' && ['.dll', '.so'].includes(extension)) return true
  if (target === 'win32-x64' && ['.dylib', '.so'].includes(extension)) return true
  return ['.node', '.dll', '.dylib', '.so'].includes(extension) && isForeignTargetPath(target, path)
}

export async function stageSeaInput(target, destination) {
  const source = resolve(root, 'runtime/dsh')
  await rm(destination, { recursive: true, force: true })
  await cp(source, destination, { recursive: true, dereference: true })
  const tree = await normalizedTreeManifest(destination)
  const excludedForeignArtifacts = tree.entries.filter(entry => isForeignTargetPath(target, entry.path))
  for (const entry of excludedForeignArtifacts) await rm(resolve(destination, entry.path), { force: true })
  return excludedForeignArtifacts
}

async function replaceExactlyOnce(path, original, replacement, name) {
  const content = await readFile(path, 'utf8')
  const matches = content.split(original).length - 1
  if (matches !== 1) throw new Error(`${name} 预期命中 1 次，实际 ${matches} 次`)
  await writeFile(path, content.replace(original, replacement))
}

export async function applySeaCompatibilityTransforms(destination) {
  await replaceExactlyOnce(
    resolve(destination, 'node_modules/node-pty/lib/unixTerminal.js'),
    'helperPath = path.resolve(__dirname, helperPath);',
    "helperPath = process.pkgNativePath ? process.pkgNativePath(path.resolve(__dirname, native.dir, 'pty.node'), 'spawn-helper') : path.resolve(__dirname, helperPath);",
    'node-pty SEA compatibility transform',
  )
  return ['node-pty-spawn-helper-v1']
}

export async function verifyPackagerPatch(lock) {
  const patch = lock.sea?.packager?.patch
  if (!patch?.path || !patch?.sha256) throw new Error('runtime lock 缺少 SEA packager patch 锁定信息')
  const patchPath = resolve(root, patch.path)
  if (await sha256(patchPath) !== patch.sha256) throw new Error(`SEA packager patch 摘要不一致：${patch.path}`)
  const checks = [
    ['prelude/bootstrap-shared.js', 'process.pkgNativePath = function pkgNativePath'],
    ['prelude/sea-vfs-setup.js', 'function _makeDirent(name, parentPath, meta, isSymbolicLink, options)'],
    ['prelude/sea-bootstrap.bundle.js', 'function _makeDirent(name, parentPath, meta, isSymbolicLink, options)'],
    ['prelude/sea-worker-entry.js', 'shared.patchDlopen(vfs.insideSnapshot)'],
    ['prelude/sea-bootstrap-core.js', 'var workerFilename = filename;'],
    ['prelude/sea-bootstrap.bundle.js', 'var workerFilename = filename;'],
    ['dictionary/node-pty.js', 'process.pkgNativePath ? process.pkgNativePath'],
    ['lib-es5/sea.js', "main: 'sea-main.js'"],
    // Windows sharp 平台包自包含 libvips，不得要求 @img/sharp-libvips-win32-x64 sibling。
    ['prelude/bootstrap-shared.js', "'@img/sharp-win32-x64': []"],
    ['prelude/sea-bootstrap.bundle.js', '"@img/sharp-win32-x64": []'],
  ]
  for (const [path, marker] of checks) {
    const content = await readFile(resolve(root, 'node_modules/@yao-pkg/pkg', path), 'utf8')
    if (!content.includes(marker)) throw new Error(`已安装 SEA packager 缺少审计补丁标记：${path}`)
  }
  return { path: patch.path, sha256: patch.sha256 }
}

export function packagerArguments(input, output) {
  return ['--sea', input, '--output', output]
}

export async function generateSeaInventories(target, outputDirectory, dshRoot = resolve(root, 'runtime/dsh')) {
  const isScript = path => ['.js', '.cjs', '.mjs'].includes(extname(path).toLowerCase())
  const isNative = path => ['.node', '.dll', '.dylib', '.so'].includes(extname(path).toLowerCase())
  const [native, scripts, assets] = await Promise.all([
    inventory(dshRoot, isNative),
    inventory(dshRoot, isScript),
    inventory(dshRoot, path => !isScript(path)),
  ])
  const foreignNative = native.entries.filter(entry => isForeignNative(target, entry.path))
  if (foreignNative.length > 0) {
    throw new Error(`SEA Native inventory 含异平台文件：${foreignNative.map(entry => entry.path).join(', ')}`)
  }
  const documents = {
    native: { ...native, target },
    scripts: { ...scripts, target },
    assets: { ...assets, target },
  }
  await mkdir(outputDirectory, { recursive: true })
  await Promise.all([
    writeFileTransactionally(resolve(outputDirectory, 'native-addons.json'), `${JSON.stringify(documents.native, null, 2)}\n`),
    writeFileTransactionally(resolve(outputDirectory, 'scripts-inventory.json'), `${JSON.stringify(documents.scripts, null, 2)}\n`),
    writeFileTransactionally(resolve(outputDirectory, 'assets-inventory.json'), `${JSON.stringify(documents.assets, null, 2)}\n`),
  ])
  return documents
}

export async function seedIsolatedSeaArchive(lock, target, isolatedHome) {
  const source = nodeArchivePath(lock, target)
  const targetConfig = targetLock(lock, target)
  const expectedBasename = basename(targetConfig.url)
  const sourceInfo = await stat(source)
  const sourceSha256 = await sha256(source)
  if (basename(source) !== expectedBasename || sourceSha256 !== targetConfig.sha256) {
    throw new Error(`SEA Node 基础归档与 runtime lock 不一致：${expectedBasename}`)
  }
  const cacheDirectory = resolve(isolatedHome, '.pkg-cache/sea')
  const destination = resolve(cacheDirectory, expectedBasename)
  await mkdir(cacheDirectory, { recursive: true })
  await copyFile(source, destination)
  const copiedSha256 = await sha256(destination)
  if (copiedSha256 !== targetConfig.sha256) {
    await rm(destination, { force: true })
    throw new Error(`SEA isolated cache 复制后摘要不一致：${expectedBasename}`)
  }
  // 锁定 packager 只在 .ok 存在时跳过下载；必须在摘要校验完成后最后写入。
  await writeFile(`${destination}.ok`, '')
  return { basename: expectedBasename, bytes: sourceInfo.size, sha256: copiedSha256, path: destination }
}

/// search 工具（glob/grep）在 packaged 模式下使用 `<executable>-rg[.exe]` sidecar：
/// native helper 无法从 pkg 的 VFS spawn。这里从锁定 production tree 复制本平台
/// ripgrep 到 SEA 目录并设为可执行，摘要进入 build receipt。
export async function stageRipgrepSidecar(target, executablePath) {
  const platform = target === 'win32-x64' ? 'win32-x64' : 'darwin-arm64'
  const sourceName = target === 'win32-x64' ? 'rg.exe' : 'rg'
  const source = resolve(root, 'runtime/dsh/node_modules', `@vscode/ripgrep-${platform}`, 'bin', sourceName)
  const directory = resolve(executablePath, '..')
  const baseName = basename(executablePath).replace(/\.exe$/i, '')
  const sidecar = target === 'win32-x64'
    ? resolve(directory, `${baseName}-rg.exe`)
    : `${executablePath}-rg`
  await copyFile(source, sidecar)
  if (target !== 'win32-x64') await chmod(sidecar, 0o755)
  return { file: basename(sidecar), bytes: (await stat(sidecar)).size, sha256: await sha256(sidecar) }
}

export async function runPackager({ lock, target, input, output, isolatedHome }) {
  const cli = resolve(root, 'node_modules/@yao-pkg/pkg/lib-es5/bin.js')
  // 锁定 packager 对 Windows target 会给输出名自动追加 `.exe`（lib-es5/config.js
  // assignTargetOutputs）；临时输出名必须预先带 `.exe`，才能与 packager 实际写出的文件一致。
  const temporaryOutput = `${output}.tmp-${process.pid}${target === 'win32-x64' ? '.exe' : ''}`
  await rm(temporaryOutput, { force: true })
  const env = { ...process.env, HOME: isolatedHome }
  for (const key of ['CHDIR', 'PKG_EXECPATH', 'PKG_NATIVE_CACHE_PATH', 'NODE_OPTIONS', 'NODE_PATH']) delete env[key]
  await execFileAsync(process.execPath, [cli, ...packagerArguments(input, temporaryOutput)], {
    cwd: resolve(input, '..'),
    env,
    maxBuffer: 128 * 1024 * 1024,
    timeout: 30 * 60_000,
  })
  if (!(await lstat(temporaryOutput)).isFile()) throw new Error('packager 未生成 SEA executable')
  await mkdir(resolve(output, '..'), { recursive: true })
  await replaceFileTransactionally(temporaryOutput, output)
  return { bytes: (await stat(output)).size, sha256: await sha256(output) }
}

export async function readSeaReceipt(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function writeSeaRuntimeManifest(paths, receipt, finalizedForPackage = false) {
  const executable = { file: basename(paths.executable), bytes: (await stat(paths.executable)).size, sha256: await sha256(paths.executable) }
  const manifest = {
    schemaVersion: 1,
    runtimeFormat: 'enhanced-sea',
    applicationVersion: receipt.applicationVersion,
    platform: receipt.platform,
    finalizedForPackage,
    executable,
    buildReceipt: { file: basename(paths.receipt), sha256: await sha256(paths.receipt) },
    nativeInventory: { file: basename(paths.nativeInventory), sha256: await sha256(paths.nativeInventory) },
    dsh: {
      package: receipt.dsh.package,
      version: receipt.dsh.version,
      patches: receipt.dsh.patches.map(patch => ({
        package: patch.package,
        version: patch.version,
        sha256: patch.sha256,
      })),
    },
    node: { version: receipt.node.version, target: receipt.node.target, archiveSha256: receipt.node.archive.sha256 },
    packager: {
      package: receipt.packager.package,
      version: receipt.packager.version,
      patchSha256: receipt.packager.patch.sha256,
    },
  }
  await writeFileTransactionally(paths.runtimeManifest, `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

export async function gitHeadAndDirty() {
  const [{ stdout: head }, { stdout: statusText }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root }),
    execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root }),
  ])
  return { head: head.trim(), provisional: statusText.trim().length > 0 }
}

export function inventoryReceipt(inventory, file) {
  return { file, files: inventory.files, bytes: inventory.bytes, contentSha256: inventory.contentSha256 }
}

export { portablePath }
