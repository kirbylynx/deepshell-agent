import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  nodeArchivePath,
  nodeExecutablePath,
  parseTargetArg,
  readLock,
  root,
  sha256,
  supportedPlatforms,
  targetLock
} from './lib/runtime.mjs'

function output(executable, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveRun(stdout.trim()) : reject(new Error(`命令失败 ${code}: ${stderr}`)))
  })
}

const lock = await readLock()
const requestedTarget = parseTargetArg()
const targets = requestedTarget === 'all' ? supportedPlatforms : [requestedTarget]
const schema = JSON.parse(await readFile(resolve(root, 'runtime/manifest/runtime-lock.schema.json'), 'utf8'))
const validate = new Ajv2020({ strict: false }).compile(schema)
if (!validate(lock)) throw new Error(`runtime-lock 无效: ${JSON.stringify(validate.errors)}`)

for (const target of targets) {
  const nodeConfig = targetLock(lock, target)
  const archive = nodeArchivePath(lock, target)
  try {
    if (await sha256(archive) !== nodeConfig.sha256) throw new Error(`${target} Node 缓存 SHA-256 不匹配`)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  await access(nodeExecutablePath(lock, target))
}

const entry = resolve(root, 'runtime/dsh', lock.dsh.entry)
for (const item of [entry, resolve(root, 'dsh/bundles/deepshell-desktop/lib/index.js'), resolve(root, 'dsh/bundles/deepshell-desktop/lib/client.js')]) await access(item)
const hostTarget = parseTargetArg([])
if (targets.includes(hostTarget)) {
  const actualNode = await output(nodeExecutablePath(lock, hostTarget), ['--version'], { env: { PATH: '/usr/bin:/bin' } })
  if (actualNode !== `v${lock.node.version}`) throw new Error(`Node 版本不一致: ${actualNode}`)
}
const packageJson = JSON.parse(await readFile(resolve(root, 'runtime/dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8'))
if (packageJson.version !== lock.dsh.version) throw new Error(`DSH 版本不一致: ${packageJson.version}`)
const installLock = JSON.parse(await readFile(resolve(root, 'runtime/dsh/node_modules/.package-lock.json'), 'utf8'))
const sourceLock = JSON.parse(await readFile(resolve(root, 'runtime/manifest/dsh-install/package-lock.json'), 'utf8'))
const sourcePackage = JSON.parse(await readFile(resolve(root, 'runtime/manifest/dsh-install/package.json'), 'utf8'))
if (sourcePackage.dependencies?.[lock.dsh.package] !== lock.dsh.version) throw new Error('DSH 安装清单版本不一致')
for (const [path, actual] of Object.entries(installLock.packages ?? {})) {
  const expected = sourceLock.packages?.[path]
  if (!expected || actual.version !== expected.version || actual.resolved !== expected.resolved || actual.integrity !== expected.integrity) {
    throw new Error(`DSH 生产依赖树与锁文件不一致: ${path}`)
  }
}
for (const [path, expected] of Object.entries(sourceLock.packages ?? {})) {
  if (path !== '' && !installLock.packages?.[path] && !expected.optional) {
    throw new Error(`DSH 生产依赖树缺少非 optional 锁定条目: ${path}`)
  }
}
const installed = installLock.packages?.['node_modules/@deepseek-ai/dsh']
if (installed?.integrity !== lock.dsh.integrity) throw new Error('DSH npm integrity 与 runtime lock 不一致')
console.log(`runtime manifest、bundled Node (${targets.join(', ')}) 与官方 DSH 入口校验通过`)
