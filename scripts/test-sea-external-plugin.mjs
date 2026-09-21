import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { currentRuntimePlatform, root } from './lib/runtime.mjs'
import { seaRuntimePaths } from './lib/sea-runtime.mjs'

const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-sea-plugin-'))
const dshHome = resolve(temporary, 'dsh-home')
const profile = resolve(dshHome, 'profiles/web')
const workspace = resolve(temporary, 'workspace')
const processHome = resolve(temporary, 'home')
const nativeCache = resolve(temporary, 'native-cache')
const readyFile = resolve(temporary, 'client-ready.json')
const fixtureName = '@deepshell-agent/sea-external-plugin-fixture'
const fixtureTarget = resolve(profile, 'node_modules/@deepshell-agent/sea-external-plugin-fixture')
const fixturePatch = resolve(fixtureTarget, 'cordis.patch.yml')
const runtime = seaRuntimePaths(currentRuntimePlatform()).executable

async function prepareProfile() {
  await cp(resolve(root, 'runtime/profile-template'), dshHome, { recursive: true })
  await cp(resolve(root, 'tests/fixtures/sea-external-plugin'), fixtureTarget, { recursive: true })
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(processHome, { recursive: true }),
    mkdir(nativeCache, { recursive: true }),
  ])
  const packagePath = resolve(profile, 'package.json')
  const document = JSON.parse(await readFile(packagePath, 'utf8'))
  document.dependencies[fixtureName] = '1.0.0'
  document.dsh.profile.bundles.push(fixtureName)
  await writeFile(packagePath, `${JSON.stringify(document, null, 2)}\n`)
}

function authenticatedUrl(child, stderr) {
  return new Promise((resolveUrl, reject) => {
    let stdout = ''
    const timer = setTimeout(() => reject(new Error(`外部 Plugin SEA 启动超时：${stderr.value.slice(-1200)}`)), 90_000)
    child.stdout.on('data', chunk => {
      stdout += chunk
      const match = stdout.match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/)
      if (match) {
        clearTimeout(timer)
        resolveUrl(match[1])
      }
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`外部 Plugin SEA 在 ready 前退出：${code}; ${stderr.value.slice(-1200)}`))
    })
  })
}

async function stop(child) {
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    await new Promise(resolveWait => killer.once('exit', resolveWait))
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    await new Promise(resolveWait => setTimeout(resolveWait, 500))
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }
}

async function run(expectLoaded, exerciseRuntimeError = false) {
  const instanceId = randomUUID()
  const stderr = { value: '' }
  const child = spawn(runtime, ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: workspace,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.platform === 'win32' ? 'C:\\Windows\\System32;C:\\Windows' : '/usr/bin:/bin',
      HOME: processHome,
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      DSH_HOME: dshHome,
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_TELEMETRY_MODE: 'DISABLED',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_DESKTOP_INSTANCE_ID: instanceId,
      DSH_DESKTOP_READY_FILE: readyFile,
      PKG_NATIVE_CACHE_PATH: nativeCache,
    },
  })
  child.stderr.on('data', chunk => { stderr.value += String(chunk).replace(/token=[^\s]+/g, 'token=<redacted>') })
  try {
    const secretUrl = await authenticatedUrl(child, stderr)
    const exchange = await fetch(secretUrl, { redirect: 'manual' })
    if (exchange.status !== 303) throw new Error(`外部 Plugin token exchange 状态异常：${exchange.status}`)
    const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
    if (!cookie) throw new Error('外部 Plugin token exchange 缺少 Cookie')
    const response = await fetch(`${new URL(secretUrl).origin}/__deepshell/external-plugin-probe`, {
      headers: { cookie },
    })
    if (response.ok !== expectLoaded) {
      throw new Error(`外部 Plugin 状态异常：expected loaded=${expectLoaded}, got status=${response.status}`)
    }
    if (expectLoaded && (await response.json()).plugin !== 'external-fixture') {
      throw new Error('外部 Plugin probe 响应无效')
    }
    if (exerciseRuntimeError) {
      const failedRequest = await fetch(`${new URL(secretUrl).origin}/__deepshell/external-plugin-error`, {
        headers: { cookie },
      })
      if (failedRequest.ok) throw new Error(`外部 Plugin 运行期错误未被 HTTP 边界拒绝：${failedRequest.status}`)
      const recovery = await fetch(`${new URL(secretUrl).origin}/__deepshell/external-plugin-probe`, {
        headers: { cookie },
      })
      if (!recovery.ok) throw new Error('外部 Plugin 运行期错误后 Web Runtime 未恢复')
    }
    if (!child.pid) throw new Error('外部 Plugin SEA 缺少 PID')
  } finally {
    await stop(child)
  }
}

async function expectLoadFailure() {
  const instanceId = randomUUID()
  const child = spawn(runtime, ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'], {
    cwd: workspace,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.platform === 'win32' ? 'C:\\Windows\\System32;C:\\Windows' : '/usr/bin:/bin',
      HOME: processHome,
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      DSH_HOME: dshHome,
      DSH_TELEMETRY_MODE: 'DISABLED',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_DESKTOP_INSTANCE_ID: instanceId,
      DSH_DESKTOP_READY_FILE: readyFile,
      PKG_NATIVE_CACHE_PATH: nativeCache,
    },
  })
  let stderr = ''
  let exited = false
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.once('exit', () => { exited = true })
  try {
    const code = await new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => reject(new Error('损坏 Plugin 未在超时内 fail closed')), 30_000)
      child.once('exit', exitCode => {
        clearTimeout(timer)
        resolveExit(exitCode)
      })
    })
    if (code === 0 || !stderr.includes('intentional external plugin fixture failure')) {
      throw new Error('损坏 Plugin 未按官方 loader 语义 fail closed')
    }
  } finally {
    if (!exited) await stop(child)
  }
}

try {
  await prepareProfile()
  await run(true, true)
  // 官方 loader 对加载期 apply() 错误采用 fail-closed，而不是忽略坏 Plugin 后继续启动。
  // 先验证该边界，再移除坏入口并证明 Runtime 可以恢复。
  await writeFile(fixturePatch, [
    '- insert:',
    '    - id: sea-external-probe',
    `      name: '${fixtureName}'`,
    '    - id: sea-external-broken',
    `      name: '${fixtureName}/broken'`,
    '',
  ].join('\n'))
  await expectLoadFailure()
  await writeFile(fixturePatch, [
    '- insert:',
    '    - id: sea-external-probe',
    `      name: '${fixtureName}'`,
    '',
  ].join('\n'))
  await writeFile(resolve(profile, 'cordis.patch.yml'), [
    '- id: sea-external-probe',
    '  disabled: true',
    '',
  ].join('\n'))
  await run(false)
  await writeFile(resolve(profile, 'cordis.patch.yml'), '[]\n')
  await run(true)
  console.log(JSON.stringify({
    ok: true,
    runtime: 'sea',
    externalPlugin: true,
    runtimeErrorContained: true,
    loadFailurePolicy: 'fail-closed',
    disable: true,
    restartRecovery: true,
  }))
} finally {
  await rm(temporary, { recursive: true, force: true })
}
