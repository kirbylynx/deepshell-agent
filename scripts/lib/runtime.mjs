import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const lockPath = resolve(root, 'runtime/manifest/runtime-lock.json')

export async function readLock() {
  return JSON.parse(await readFile(lockPath, 'utf8'))
}

export const supportedPlatforms = ['darwin-arm64', 'win32-x64']

export function currentRuntimePlatform() {
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-arm64'
  if (process.platform === 'win32' && process.arch === 'x64') return 'win32-x64'
  throw new Error(`当前平台暂不支持：${process.platform}-${process.arch}`)
}

export function parseTargetArg(argv = process.argv.slice(2)) {
  const index = argv.indexOf('--target')
  if (index >= 0) {
    const value = argv[index + 1]
    if (!value) throw new Error('--target 缺少取值')
    if (value === 'all') return value
    if (!supportedPlatforms.includes(value)) throw new Error(`不支持的 runtime target：${value}`)
    return value
  }
  const inline = argv.find(value => value.startsWith('--target='))
  if (inline) {
    const value = inline.slice('--target='.length)
    if (!value) throw new Error('--target 缺少取值')
    if (value === 'all') return value
    if (!supportedPlatforms.includes(value)) throw new Error(`不支持的 runtime target：${value}`)
    return value
  }
  return currentRuntimePlatform()
}

export function targetLock(lock, target) {
  if (!supportedPlatforms.includes(target)) {
    throw new Error(`不支持的 runtime target：${target}`)
  }
  const nodeTarget = lock.node?.targets?.[target]
  if (!nodeTarget) throw new Error(`runtime lock 缺少 ${target} Node 配置`)
  return nodeTarget
}

export function nodeTargetDirectory(target) {
  return resolve(root, 'runtime/node', target)
}

export function nodeExecutablePath(lock, target) {
  return resolve(nodeTargetDirectory(target), targetLock(lock, target).executable)
}

export function nodeArchivePath(lock, target) {
  return resolve(root, 'runtime/cache', basename(targetLock(lock, target).url))
}

export async function sha256(path) {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

export function assertExactVersion(value, label) {
  if (typeof value !== 'string' || value === '' || /[~^*]|latest/i.test(value)) {
    throw new Error(`${label} 必须是精确版本`)
  }
}
