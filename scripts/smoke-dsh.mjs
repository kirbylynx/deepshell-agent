import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { currentRuntimePlatform, nodeExecutablePath, readLock, root } from './lib/runtime.mjs'

const lock = await readLock()
const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-smoke-'))
const dshHome = resolve(temporary, 'dsh-home')
const workspace = resolve(temporary, 'bootstrap-workspace')
const readyFile = resolve(temporary, 'client-ready.json')
await cp(resolve(root, 'runtime/profile-template'), dshHome, { recursive: true })
await mkdir(workspace, { recursive: true })
const instanceId = randomUUID()
const hostTarget = currentRuntimePlatform()

const child = spawn(
  nodeExecutablePath(lock, hostTarget),
  [resolve(root, 'runtime/dsh', lock.dsh.entry), 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
  {
    cwd: workspace,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH ?? (process.platform === 'win32' ? 'C:\\Windows\\System32;C:\\Windows' : '/usr/bin:/bin'),
      HOME: process.env.HOME,
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      DSH_HOME: dshHome,
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_TELEMETRY_MODE: 'DISABLED',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_CLIENT_TITLE: 'DeepShell Agent',
      DSH_DESKTOP_INSTANCE_ID: instanceId,
      DSH_DESKTOP_READY_FILE: readyFile
    }
  }
)

let stderr = ''
child.stderr.on('data', chunk => { stderr += String(chunk).replace(/token=[^\s]+/g, 'token=<redacted>') })

function authenticatedUrl() {
  return new Promise((resolveUrl, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`DSH smoke 超时: ${stderr.slice(-1200)}`)), 90_000)
    child.stdout.on('data', chunk => {
      buffer += chunk
      const match = buffer.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
      if (match) {
        clearTimeout(timer)
        resolveUrl(match[1])
      }
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`DSH 在 ready 前退出: ${code}; ${stderr.slice(-1200)}`))
    })
  })
}

try {
  const secretUrl = await authenticatedUrl()
  const exchange = await fetch(secretUrl, { redirect: 'manual' })
  if (exchange.status !== 303) throw new Error(`token exchange 状态异常: ${exchange.status}`)
  const setCookie = exchange.headers.get('set-cookie')
  if (!setCookie) throw new Error('token exchange 未返回 Cookie')
  const origin = new URL(secretUrl).origin
  const index = await fetch(`${origin}/`, { headers: { cookie: setCookie.split(';', 1)[0] } })
  if (!index.ok) throw new Error(`认证 index 状态异常: ${index.status}`)
  const html = await index.text()
  if (!html.includes('Content-Security-Policy')) throw new Error('DSH 页面未注入 CSP')
  if (!html.includes('__DEEPSHELL_INSTANCE_ID__')) throw new Error('DSH 页面未注入实例绑定信息')
  if (!html.includes('@deepshell-agent/dsh-desktop')) throw new Error('Branding Client Plugin 未进入官方 boot graph')
  console.log(JSON.stringify({ ok: true, host: '127.0.0.1', dynamicPort: true, authCookie: true, csp: true, instanceBound: true, brandingGraph: true }))
} finally {
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
  }
  await new Promise(resolveWait => setTimeout(resolveWait, 500))
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }
  await rm(temporary, { recursive: true, force: true })
}
