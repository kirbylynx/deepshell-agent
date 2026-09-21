import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { relative, resolve, sep } from 'node:path'
import { currentRuntimePlatform, readLock, root, sha256 } from './lib/runtime.mjs'
import { seaRuntimePaths } from './lib/sea-runtime.mjs'

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

async function hashFile(path) {
  return await new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', rejectHash)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function treeFiles(rootPath) {
  const files = []
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)))
    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const metadata = await lstat(path, { bigint: true })
      if (metadata.isSymbolicLink()) throw new Error('SEA on-device Cache 不允许符号链接或 reparse point')
      if (metadata.isDirectory()) {
        await visit(path)
      } else if (metadata.isFile()) {
        files.push({
          path: relative(rootPath, path).split(sep).join('/'),
          bytes: Number(metadata.size),
          allocatedBytes: typeof metadata.blocks === 'bigint' ? Number(metadata.blocks * 512n) : null,
          sha256: await hashFile(path),
        })
      } else {
        throw new Error('SEA on-device Cache 包含不支持的文件类型')
      }
    }
  }
  await visit(rootPath)
  files.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)))
  return files
}

async function requireRealPath(path, expectedType) {
  const metadata = await lstat(path, { bigint: true })
  if (metadata.isSymbolicLink()) {
    throw new Error('SEA on-device Cache 不允许符号链接或 reparse point')
  }
  if ((expectedType === 'directory' && !metadata.isDirectory())
    || (expectedType === 'file' && !metadata.isFile())) {
    throw new Error(`SEA on-device Cache 路径类型无效：${expectedType}`)
  }
  return metadata
}

function metrics(files) {
  const allocated = files.map(file => file.allocatedBytes)
  if (allocated.some(value => value === null)) throw new Error('当前平台无法取得 Cache allocated bytes')
  return {
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    allocatedBytes: allocated.reduce((sum, value) => sum + value, 0),
  }
}

const target = currentRuntimePlatform()
const lock = await readLock()
const executableSha256 = await sha256(seaRuntimePaths(target).executable)
const defaultAppData = process.platform === 'darwin'
  ? resolve(homedir(), 'Library/Application Support/com.deepshell.agent')
  : process.env.APPDATA
    ? resolve(process.env.APPDATA, 'com.deepshell.agent')
    : null
const appData = argValue(
  '--app-data',
  defaultAppData,
)
if (!appData) throw new Error('无法解析应用数据目录，请显式传入 --app-data')
const platformRoot = resolve(appData, 'runtime-cache/native', target)
const generation = resolve(platformRoot, executableSha256)
const pkgNative = resolve(generation, 'pkg-native')
const manifestPath = resolve(generation, 'deepshell-cache-manifest.json')
const lockPath = resolve(platformRoot, `${executableSha256}.lock`)
await Promise.all([
  requireRealPath(platformRoot, 'directory'),
  requireRealPath(generation, 'directory'),
  requireRealPath(pkgNative, 'directory'),
])
const [manifest, nativeFiles, manifestMetadata, lockMetadata] = await Promise.all([
  readFile(manifestPath, 'utf8').then(JSON.parse),
  treeFiles(pkgNative),
  requireRealPath(manifestPath, 'file'),
  requireRealPath(lockPath, 'file'),
])
if (manifest.schemaVersion !== 1 || manifest.platform !== target || manifest.seaSha256 !== executableSha256
  || manifest.packagerVersion !== lock.sea.packager.version || manifest.bootSuccessful !== true) {
  throw new Error('SEA on-device Cache manifest 与当前 Runtime 不匹配')
}
const expectedFiles = nativeFiles.map(file => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }))
if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) {
  throw new Error('SEA on-device Cache manifest 与 pkg-native tree 不一致')
}
const controllerFiles = [manifestMetadata, lockMetadata].map(metadata => ({
  bytes: Number(metadata.size),
  allocatedBytes: typeof metadata.blocks === 'bigint' ? Number(metadata.blocks * 512n) : null,
}))
const report = {
  schemaVersion: 1,
  applicationVersion: lock.applicationVersion,
  target,
  seaSha256: executableSha256,
  nativeCache: metrics(nativeFiles),
  controller: metrics(controllerFiles),
  passed: true,
}
const outputDirectory = resolve(root, 'runtime/staging')
await mkdir(outputDirectory, { recursive: true })
const output = resolve(outputDirectory, `sea-on-device-${target}.json`)
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ ok: true, output: relative(root, output).split(sep).join('/'), ...report }))
