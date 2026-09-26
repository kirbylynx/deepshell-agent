import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { promisify } from 'node:util'
import WebSocket from 'ws'
import { currentRuntimePlatform, nodeExecutablePath, readLock, root } from './lib/runtime.mjs'
import { seaRuntimePaths } from './lib/sea-runtime.mjs'

const execFileAsync = promisify(execFile)
const lock = await readLock()
const target = currentRuntimePlatform()

function argumentNumber(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index < 0) return fallback
  const value = Number(process.argv[index + 1])
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} 必须是非负整数`)
  return value
}

const runs = argumentNumber('--runs', 10)
const freshRuns = argumentNumber('--fresh-runs', 1)
const idleSeconds = argumentNumber('--idle-seconds', 30)
if (runs < 1) throw new Error('--runs 必须至少为 1')
if (freshRuns < 1) throw new Error('--fresh-runs 必须至少为 1')

// 平台默认 Chromium 候选：macOS 用 Chrome；Windows 用 Chrome 或 Edge（均为 Chromium 内核，支持 CDP）。
function defaultBrowserCandidates() {
  if (process.platform !== 'win32') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  const bases = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env['LOCALAPPDATA']].filter(Boolean)
  return bases.flatMap(base => [
    resolve(base, 'Google/Chrome/Application/chrome.exe'),
    resolve(base, 'Microsoft/Edge/Application/msedge.exe'),
  ])
}
async function resolveDefaultBrowser() {
  const candidates = defaultBrowserCandidates()
  for (const candidate of candidates) {
    try { await stat(candidate); return candidate } catch {}
  }
  return candidates[0]
}
const browser = process.env.DEEPSHELL_BENCH_BROWSER ?? await resolveDefaultBrowser()
await stat(browser).catch(() => {
  throw new Error(`缺少 benchmark 浏览器：${browser}；可通过 DEEPSHELL_BENCH_BROWSER 指定 Chromium`)
})

const temporary = await mkdtemp(resolve(tmpdir(), 'deepshell-sea-benchmark-'))
const workspace = resolve(temporary, 'workspace')
const processHome = resolve(temporary, 'process-home')
const standardHome = resolve(temporary, 'dsh-standard')
const seaHome = resolve(temporary, 'dsh-sea')
const nativeCache = resolve(temporary, 'native-cache')
await Promise.all([
  mkdir(workspace, { recursive: true }),
  mkdir(processHome, { recursive: true }),
  cp(resolve(root, 'runtime/profile-template'), standardHome, { recursive: true }),
  cp(resolve(root, 'runtime/profile-template'), seaHome, { recursive: true }),
])

const sleep = milliseconds => new Promise(resolveWait => setTimeout(resolveWait, milliseconds))
const elapsedMs = started => Number(process.hrtime.bigint() - started) / 1_000_000
const activeChildren = new Set()

async function stopProcess(child) {
  if (!child) return
  if (child.exitCode !== null) {
    activeChildren.delete(child)
    return
  }
  if (process.platform === 'win32') {
    // Windows 没有 POSIX 进程组信号；用 taskkill /T 终止整棵进程树。
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {}
    await sleep(500)
    activeChildren.delete(child)
    return
  }
  try { process.kill(-child.pid, 'SIGTERM') } catch {}
  const exited = await Promise.race([
    new Promise(resolveExit => child.once('exit', () => resolveExit(true))),
    sleep(2_000).then(() => false),
  ])
  if (!exited) {
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }
  activeChildren.delete(child)
}

process.once('SIGINT', async () => {
  await Promise.all([...activeChildren].map(stopProcess))
  process.exit(130)
})

async function openAuthenticatedBrowser(secretUrl, browserData) {
  const exchange = await fetch(secretUrl, { redirect: 'manual' })
  if (exchange.status !== 303) throw new Error(`token exchange 状态异常：${exchange.status}`)
  const setCookie = exchange.headers.get('set-cookie')
  if (!setCookie) throw new Error('token exchange 未返回 Cookie')
  const pair = setCookie.split(';', 1)[0]
  const separator = pair.indexOf('=')
  if (separator <= 0) throw new Error('token exchange Cookie 格式无效')
  const name = pair.slice(0, separator)
  const value = pair.slice(separator + 1)
  const origin = new URL(secretUrl).origin

  const chrome = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${browserData}`, 'about:blank',
  ], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
  activeChildren.add(chrome)
  const webSocketUrl = await new Promise((resolveUrl, rejectUrl) => {
    let diagnostics = ''
    const timer = setTimeout(() => rejectUrl(new Error(`等待 Chrome CDP 超时：${diagnostics.slice(-500)}`)), 15_000)
    chrome.stderr.on('data', chunk => {
      diagnostics = `${diagnostics}${String(chunk)}`.slice(-2000)
      const match = diagnostics.match(/DevTools listening on (ws:\/\/[^\s]+)/)
      if (match) {
        clearTimeout(timer)
        resolveUrl(match[1])
      }
    })
    chrome.once('exit', code => {
      clearTimeout(timer)
      rejectUrl(new Error(`Chrome 在 CDP 就绪前退出：${code}`))
    })
  })
  const socket = new WebSocket(webSocketUrl)
  await new Promise((resolveOpen, rejectOpen) => {
    socket.once('open', resolveOpen)
    socket.once('error', rejectOpen)
  })
  let requestId = 0
  const pending = new Map()
  socket.on('message', payload => {
    const message = JSON.parse(String(payload))
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(`CDP ${message.error.code}: ${message.error.message}`))
    else waiter.resolve(message.result ?? {})
  })
  const request = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = ++requestId
    pending.set(id, { resolve: resolveRequest, reject: rejectRequest })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const { browserContextId } = await request('Target.createBrowserContext')
  await request('Storage.setCookies', {
    browserContextId,
    cookies: [{ name, value, url: `${origin}/`, httpOnly: true, secure: false, sameSite: 'Strict' }],
  })
  await request('Target.createTarget', { browserContextId, url: `${origin}/` })
  return { chrome, socket }
}

async function treeMetrics(path) {
  let files = 0
  let bytes = 0
  let allocatedBytes = 0
  let allocatedAvailable = true
  async function visit(current) {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const candidate = resolve(current, entry.name)
      if (entry.isDirectory()) await visit(candidate)
      else if (entry.isFile()) {
        const metadata = await stat(candidate, { bigint: true })
        files += 1
        bytes += Number(metadata.size)
        if (typeof metadata.blocks === 'bigint') allocatedBytes += Number(metadata.blocks * 512n)
        else allocatedAvailable = false
      }
    }
  }
  await visit(path).catch(error => {
    if (error?.code !== 'ENOENT') throw error
  })
  // Windows 的 stat 不提供 blocks；按 D-1507 标为不可用而不是伪装为 0。
  return { files, bytes, allocatedBytes: allocatedAvailable ? allocatedBytes : null }
}

async function processTreeRssKiB(rootPid) {
  // 口径统一为受管 Runtime 进程树的常驻内存 KiB：macOS 用 ps rss，Windows 用 CIM WorkingSetSize。
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Csv -NoTypeInformation',
    ], { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 })
    const rows = stdout.trim().split(/\r?\n/).slice(1)
      .map(line => line.replace(/"/g, '').split(',').map(Number))
      .filter(row => row.length === 3 && row.every(Number.isFinite))
    const descendants = new Set([rootPid])
    let changed = true
    while (changed) {
      changed = false
      for (const [pid, ppid] of rows) {
        if (descendants.has(ppid) && !descendants.has(pid)) {
          descendants.add(pid)
          changed = true
        }
      }
    }
    const bytes = rows.filter(([pid]) => descendants.has(pid)).reduce((sum, [, , workingSet]) => sum + workingSet, 0)
    return Math.round(bytes / 1024)
  }
  const { stdout } = await execFileAsync('/bin/ps', ['-axo', 'pid=,ppid=,rss='])
  const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number))
    .filter(row => row.length === 3 && row.every(Number.isFinite))
  const descendants = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const [pid, ppid] of rows) {
      if (descendants.has(ppid) && !descendants.has(pid)) {
        descendants.add(pid)
        changed = true
      }
    }
  }
  return rows.filter(([pid]) => descendants.has(pid)).reduce((sum, [, , rss]) => sum + rss, 0)
}

async function waitForReadyFile(path, expected, stderrTail) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    try {
      const payload = JSON.parse(await readFile(path, 'utf8'))
      if (payload.instanceId !== expected.instanceId || payload.baseline !== 'ready'
        || payload.pid !== expected.pid || payload.host !== '127.0.0.1' || payload.port !== expected.port) {
        throw new Error('Ready 文件与当前 Runtime 实例不匹配')
      }
      return
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    await sleep(25)
  }
  throw new Error(`等待 Ready Gate 超时：${stderrTail()}`)
}

async function runSample({ runtime, dshHome, resetCache, sample }) {
  if (resetCache) await rm(nativeCache, { recursive: true, force: true })
  await mkdir(nativeCache, { recursive: true })
  const readyFile = resolve(temporary, `ready-${runtime}-${sample}-${randomUUID()}.json`)
  const browserData = resolve(temporary, `browser-${runtime}-${sample}-${randomUUID()}`)
  const instanceId = randomUUID()
  const executable = runtime === 'sea' ? seaRuntimePaths(target).executable : nodeExecutablePath(lock, target)
  const args = runtime === 'sea'
    ? ['web', '--no-open', '--host', '127.0.0.1', '--port', '0']
    : [resolve(root, 'runtime/dsh', lock.dsh.entry), 'web', '--no-open', '--host', '127.0.0.1', '--port', '0']
  const child = spawn(executable, args, {
    cwd: workspace,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.platform === 'win32' ? 'C:\\Windows\\System32;C:\\Windows' : '/usr/bin:/bin',
      HOME: processHome,
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      DSH_HOME: dshHome,
      DSH_PERMISSION_MODE: 'workspace-write',
      DSH_TELEMETRY_MODE: 'DISABLED',
      DSH_TELEMETRY_DISABLED: '1',
      DSH_CLIENT_TITLE: 'DeepShell Agent',
      DSH_DESKTOP_INSTANCE_ID: instanceId,
      DSH_DESKTOP_READY_FILE: readyFile,
      ...(runtime === 'sea' ? { PKG_NATIVE_CACHE_PATH: nativeCache } : {}),
    },
  })
  activeChildren.add(child)
  let chrome
  let browserSocket
  let stderr = ''
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${String(chunk).replace(/token=[^\s]+/g, 'token=<redacted>')}`.slice(-2000)
  })
  try {
    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn)
      child.once('error', rejectSpawn)
    })
    const started = process.hrtime.bigint()
    const secretUrl = await new Promise((resolveUrl, rejectUrl) => {
      let stdout = ''
      const timer = setTimeout(() => rejectUrl(new Error(`等待 DSH URL 超时：${stderr}`)), 90_000)
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
        rejectUrl(new Error(`DSH 在 Ready Gate 前退出：${code}; ${stderr}`))
      })
    })
    const port = Number(new URL(secretUrl).port)
    const authenticatedBrowser = await openAuthenticatedBrowser(secretUrl, browserData)
    chrome = authenticatedBrowser.chrome
    browserSocket = authenticatedBrowser.socket
    await waitForReadyFile(readyFile, { instanceId, pid: child.pid, port }, () => stderr)
    const readyGateMs = elapsedMs(started)
    await sleep(idleSeconds * 1000)
    const rssKiB = await processTreeRssKiB(child.pid)
    const cache = runtime === 'sea' ? await treeMetrics(nativeCache) : { files: 0, bytes: 0, allocatedBytes: 0 }
    const proxy = await treeMetrics(resolve(dshHome, 'profiles/node_modules'))
    const result = { sample, readyGateMs: Number(readyGateMs.toFixed(3)), rssKiB, cache, proxy }
    process.stderr.write(`${JSON.stringify({ runtime, resetCache, ...result })}\n`)
    return result
  } finally {
    browserSocket?.close()
    await stopProcess(chrome)
    await stopProcess(child)
    await rm(browserData, { recursive: true, force: true })
    await rm(readyFile, { force: true })
  }
}

function summarize(samples) {
  const ready = samples.map(sample => sample.readyGateMs).sort((a, b) => a - b)
  const rss = samples.map(sample => sample.rssKiB).sort((a, b) => a - b)
  const median = values => values.length % 2 === 1
    ? values[(values.length - 1) / 2]
    : (values[values.length / 2 - 1] + values[values.length / 2]) / 2
  return {
    samples,
    readyGateMs: { median: Number(median(ready).toFixed(3)), max: ready.at(-1) },
    rssKiB: { median: Number(median(rss).toFixed(1)), max: rss.at(-1) },
  }
}

function comparison(candidate, baseline, percentLimit, absoluteLimit, unitScale = 1) {
  const delta = candidate - baseline
  const percent = baseline === 0 ? null : delta / baseline * 100
  return {
    baseline,
    candidate,
    delta: Number(delta.toFixed(3)),
    percent: percent === null ? null : Number(percent.toFixed(3)),
    percentLimit,
    absoluteLimit,
    passed: delta <= baseline * percentLimit / 100 && delta <= absoluteLimit * unitScale,
  }
}

async function sampleGroup(runtime, dshHome, resetCache) {
  const samples = []
  for (let sample = 1; sample <= runs; sample += 1) {
    samples.push(await runSample({ runtime, dshHome, resetCache, sample }))
  }
  return summarize(samples)
}

async function freshAppDataGroup() {
  const samples = []
  for (let sample = 1; sample <= freshRuns; sample += 1) {
    const dshHome = resolve(temporary, `dsh-sea-fresh-${sample}`)
    await cp(resolve(root, 'runtime/profile-template'), dshHome, { recursive: true })
    try {
      samples.push(await runSample({ runtime: 'sea', dshHome, resetCache: true, sample }))
    } finally {
      await rm(dshHome, { recursive: true, force: true })
    }
  }
  return summarize(samples)
}

async function runNativeProbePass(executable, probes) {
  for (const probe of probes) {
    const { stdout } = await execFileAsync(executable, ['--deepshell-sea-probe', probe], {
      cwd: workspace,
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
      env: {
        PATH: process.platform === 'win32' ? 'C:\\Windows\\System32;C:\\Windows' : '/usr/bin:/bin',
        HOME: processHome,
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        PKG_NATIVE_CACHE_PATH: nativeCache,
      },
    })
    const result = JSON.parse(stdout.trim())
    if (result.ok !== true) throw new Error(`SEA Native probe 未通过：${probe}`)
  }
  return await treeMetrics(nativeCache)
}

async function nativeProbeSuite() {
  const executable = seaRuntimePaths(target).executable
  const probes = [
    'identity', 'worker', 'self-spawn', 'node-pty', 'sharp',
    'koffi', 'flock', 'require-builtin', 'client-resolution',
  ]
  await rm(nativeCache, { recursive: true, force: true })
  await mkdir(nativeCache, { recursive: true })
  const first = await runNativeProbePass(executable, probes)
  const second = await runNativeProbePass(executable, probes)
  const fileCountUnchanged = first.files === second.files
  const contentSizeUnchanged = first.bytes === second.bytes && first.allocatedBytes === second.allocatedBytes
  return { probes, first, second, fileCountUnchanged, contentSizeUnchanged, passed: fileCountUnchanged && contentSizeUnchanged }
}

try {
  await runSample({ runtime: 'standard', dshHome: standardHome, resetCache: false, sample: 'warmup' })
  await runSample({ runtime: 'sea', dshHome: seaHome, resetCache: true, sample: 'warmup' })
  const standard = await sampleGroup('standard', standardHome, false)
  const seaFirstCache = await sampleGroup('sea', seaHome, true)
  const seaWarm = await sampleGroup('sea', seaHome, false)
  const seaFreshAppData = await freshAppDataGroup()
  const nativeProbes = await nativeProbeSuite()
  const gates = {
    warmReady: comparison(seaWarm.readyGateMs.median, standard.readyGateMs.median, 20, 2_000),
    firstCacheReady: comparison(seaFirstCache.readyGateMs.median, standard.readyGateMs.median, 50, 5_000),
    warmRss: comparison(seaWarm.rssKiB.median, standard.rssKiB.median, 20, 64, 1024),
  }
  const report = {
    schemaVersion: 1,
    target,
    dshVersion: lock.dsh.version,
    nodeVersion: lock.node.version,
    seaSha256: await import('./lib/runtime.mjs').then(module => module.sha256(seaRuntimePaths(target).executable)),
    environment: { os: process.platform, arch: process.arch, browser: basename(browser), runs, freshRuns, idleSeconds },
    groups: { standard, seaFirstCache, seaWarm, seaFreshAppData },
    nativeProbes,
    gates,
    passed: Object.values(gates).every(gate => gate.passed) && nativeProbes.passed,
  }
  const output = resolve(root, `runtime/staging/sea-performance-${target}.json`)
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ ok: report.passed, output: `runtime/staging/sea-performance-${target}.json`, gates }))
  if (!report.passed) process.exitCode = 1
} finally {
  await Promise.all([...activeChildren].map(stopProcess))
  await rm(temporary, { recursive: true, force: true })
}
