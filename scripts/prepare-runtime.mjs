import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import {
  assertExactVersion,
  currentRuntimePlatform,
  nodeArchivePath,
  nodeExecutablePath,
  nodeTargetDirectory,
  parseTargetArg,
  readLock,
  root,
  sha256,
  supportedPlatforms,
  targetLock
} from './lib/runtime.mjs'

function run(executable, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${executable} 退出码 ${code}`)))
  })
}

const lock = await readLock()
const requestedTarget = parseTargetArg()
const targets = requestedTarget === 'all' ? supportedPlatforms : [requestedTarget]
assertExactVersion(lock.node.version, 'Node')
assertExactVersion(lock.dsh.version, 'DSH')
const cache = resolve(root, 'runtime/cache')
const dshTarget = resolve(root, 'runtime/dsh')
const dshInstall = resolve(root, 'runtime/manifest/dsh-install')
await mkdir(cache, { recursive: true })

async function download(url, destination) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载失败 ${response.status}: ${url}`)
  await writeFile(destination, Buffer.from(await response.arrayBuffer()))
}

async function extractArchive(nodeConfig, archive, nodeStaging, target) {
  if (nodeConfig.archiveType === 'tar.gz') {
    await run(process.platform === 'win32' ? 'tar.exe' : '/usr/bin/tar', ['-xzf', archive, '-C', nodeStaging, '--strip-components=1'])
    return
  }
  if (nodeConfig.archiveType === 'zip') {
    const expanded = await mkdtemp(resolve(tmpdir(), `deepshell-node-expanded-${target}-`))
    try {
      if (process.platform === 'win32') {
        await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${expanded.replaceAll("'", "''")}' -Force`])
      } else {
        await run('/usr/bin/unzip', ['-q', archive, '-d', expanded])
      }
      await cp(resolve(expanded, `node-v${lock.node.version}-win-x64`), nodeStaging, { recursive: true, dereference: true })
    } finally {
      await rm(expanded, { recursive: true, force: true })
    }
    return
  }
  throw new Error(`不支持的 Node archiveType：${nodeConfig.archiveType}`)
}

async function prepareNode(target) {
  const nodeConfig = targetLock(lock, target)
  const archive = nodeArchivePath(lock, target)
  try {
    if (await sha256(archive) !== nodeConfig.sha256) throw new Error('缓存校验和不匹配')
  } catch {
    await download(nodeConfig.url, archive)
  }
  if (await sha256(archive) !== nodeConfig.sha256) throw new Error(`${target} Node 发行物 SHA-256 不匹配`)

  const nodeTarget = nodeTargetDirectory(target)
  const nodeStaging = await mkdtemp(resolve(tmpdir(), `deepshell-node-${target}-`))
  try {
    await extractArchive(nodeConfig, archive, nodeStaging, target)
    await rm(nodeTarget, { recursive: true, force: true })
    await mkdir(resolve(nodeTarget, '..'), { recursive: true })
    await rename(nodeStaging, nodeTarget)
    if (target !== 'win32-x64') await chmod(nodeExecutablePath(lock, target), 0o755)
  } catch (error) {
    await rm(nodeStaging, { recursive: true, force: true })
    throw error
  }
}

for (const target of targets) await prepareNode(target)
const hostTarget = currentRuntimePlatform()
if (!targets.includes(hostTarget)) await prepareNode(hostTarget)

const dshStaging = await mkdtemp(resolve(tmpdir(), 'deepshell-dsh-'))
try {
  const installPackage = JSON.parse(await readFile(resolve(dshInstall, 'package.json'), 'utf8'))
  if (installPackage.dependencies?.[lock.dsh.package] !== lock.dsh.version) {
    throw new Error('DSH 安装清单与 runtime lock 版本不一致')
  }
  await cp(resolve(dshInstall, 'package.json'), resolve(dshStaging, 'package.json'))
  await cp(resolve(dshInstall, 'package-lock.json'), resolve(dshStaging, 'package-lock.json'))
  const node = nodeExecutablePath(lock, hostTarget)
  const npmCli = resolve(nodeTargetDirectory(hostTarget), 'lib/node_modules/npm/bin/npm-cli.js')
  await run(node, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dshStaging })
  await rm(dshTarget, { recursive: true, force: true })
  await mkdir(dshTarget, { recursive: true })
  await cp(resolve(dshStaging, 'node_modules'), resolve(dshTarget, 'node_modules'), { recursive: true, dereference: true })
} finally {
  await rm(dshStaging, { recursive: true, force: true })
}

console.log(`runtime prepared: Node ${lock.node.version} (${targets.join(', ')}), DSH ${lock.dsh.version}`)
