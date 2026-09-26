import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { createRequire } from 'node:module'

function writeResult(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function probeWorker() {
  const filename = fileURLToPath(new URL('./sea-probe-worker.mjs', import.meta.url))
  return await new Promise((resolveProbe, reject) => {
    const worker = new Worker(filename)
    worker.once('message', resolveProbe)
    worker.once('error', reject)
  })
}

async function probeSessionPersistenceWorker() {
  const packageUrl = import.meta.resolve('@deepseek-ai/dsh-session-persistence-jsonl/package.json')
  const entry = new URL('./lib/worker.cjs', packageUrl)
  return await new Promise((resolveProbe, reject) => {
    const worker = new Worker(entry, { workerData: {}, execArgv: [] })
    worker.once('message', value => reject(new Error(`DSH Session Worker 对无效探针返回了意外消息：${JSON.stringify(value)}`)))
    worker.once('error', error => {
      if (error instanceof Error && error.message.includes('migration verifier request is malformed')) {
        resolveProbe({ ok: true, packaged: Boolean(process.pkg), entry: entry.pathname })
      } else {
        reject(error)
      }
    })
    worker.once('exit', code => {
      if (code === 0) reject(new Error('DSH Session Worker 未执行请求校验'))
    })
  })
}

async function probeSelfSpawn() {
  return await new Promise((resolveProbe, reject) => {
    const child = spawn(process.execPath, ['--deepshell-sea-probe', 'child'], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('exit', code => {
      if (code !== 0) reject(new Error(`SEA self-spawn 失败：${code}; ${stderr}`))
      else resolveProbe(JSON.parse(stdout.trim()))
    })
  })
}

async function probePty() {
  const { spawn: spawnPty } = await import('node-pty')
  // Windows 走 ConPTY + cmd.exe；macOS/Linux 走 /bin/sh。
  const windows = process.platform === 'win32'
  const marker = `deepshell-sea-pty-${process.pid}`
  const shell = windows ? 'C:\\Windows\\System32\\cmd.exe' : '/bin/sh'
  const shellArguments = windows ? ['/d', '/s', '/c', `echo ${marker}`] : ['-c', `printf ${marker}`]
  return await new Promise((resolveProbe, reject) => {
    const terminal = spawnPty(shell, shellArguments, {
      cols: 80,
      rows: 24,
      cwd: tmpdir(),
      env: { PATH: windows ? 'C:\\Windows\\System32;C:\\Windows' : '/usr/bin:/bin' },
    })
    let output = ''
    const finish = error => {
      clearTimeout(timer)
      // 显式 kill 释放 ConPTY 的 conout worker 与 socket；Windows 上否则进程无法退出。
      try { terminal.kill() } catch {}
      if (error) reject(error)
      else resolveProbe({ ok: true, marker })
    }
    const timer = setTimeout(() => finish(new Error('node-pty probe 超时')), 5_000)
    terminal.onData(data => { output += data })
    terminal.onExit(({ exitCode }) => {
      if (exitCode !== 0 || !output.includes(marker)) finish(new Error(`node-pty probe 失败：${exitCode}`))
      else finish()
    })
  })
}

async function probeSharp() {
  const { default: sharp } = await import('sharp')
  const source = Buffer.from([
    255, 0, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255,
  ])
  const output = await sharp(source, { raw: { width: 2, height: 2, channels: 3 } })
    .resize(1, 1)
    .raw()
    .toBuffer({ resolveWithObject: true })
  if (output.info.width !== 1 || output.info.height !== 1 || output.data.length !== 3) {
    throw new Error('sharp resize 结果异常')
  }
  return { ok: true, width: output.info.width, height: output.info.height }
}

async function probeKoffi() {
  const { default: koffi } = await import('koffi')
  // Windows 用 kernel32 的 GetCurrentProcessId；macOS 用 libSystem 的 getpid。
  const windows = process.platform === 'win32'
  const library = koffi.load(windows ? 'kernel32.dll' : '/usr/lib/libSystem.B.dylib')
  const getpid = windows ? library.func('uint32 GetCurrentProcessId()') : library.func('int getpid()')
  const pid = getpid()
  if (pid !== process.pid) throw new Error(`koffi getpid 不一致：${pid}`)
  return { ok: true, pid }
}

async function probeFlock() {
  // DSH 上游 system addon 只提供 darwin/linux 平台包；Windows 侧不存在 flock 实现，
  // 该探针在 Windows 上显式标记不适用，不伪装通过。
  if (process.platform === 'win32') {
    return { ok: true, applicable: false, reason: 'node-addon-system flock 无 win32-x64 平台包' }
  }
  const { tryLockExclusive } = await import('@deepseek-ai/node-addon-system/flock')
  const directory = mkdtempSync(resolve(tmpdir(), 'deepshell-sea-flock-'))
  const lockPath = resolve(directory, 'probe.lock')
  const first = openSync(lockPath, 'a+')
  const second = openSync(lockPath, 'a+')
  try {
    await tryLockExclusive(first)
    let contended = false
    try {
      await tryLockExclusive(second)
    } catch (error) {
      contended = ['EAGAIN', 'EWOULDBLOCK'].includes(error?.code)
    }
    if (!contended) throw new Error('flock 未观察到竞争')
    closeSync(first)
    await tryLockExclusive(second)
    return { ok: true, contended }
  } finally {
    try { closeSync(first) } catch {}
    try { closeSync(second) } catch {}
    rmSync(directory, { recursive: true, force: true })
  }
}

async function probeRequireBuiltin() {
  const module = await import('node-addon-require-builtin')
  const loader = module.requireBuiltin('internal/modules/esm/loader')
  if (typeof loader.getOrInitializeCascadedLoader !== 'function') {
    throw new Error('require-builtin 未加载 DSH 需要的 internal ESM loader')
  }
  let rejected = false
  try {
    module.requireBuiltin('deepshell:not-a-builtin')
  } catch {
    rejected = true
  }
  if (!rejected) throw new Error('require-builtin 未拒绝非 builtin')
  return { ok: true, rejected }
}

async function probeClientResolution() {
  const module = await import('node-addon-require-builtin')
  const raw = module.requireBuiltin('internal/modules/esm/loader').getOrInitializeCascadedLoader()
  const version = typeof raw.getOrCreateModuleJob === 'function' ? 'v2' : 'v1'
  const baseUrl = import.meta.resolve('@deepseek-ai/dsh-web-app')
  const names = ['@deepseek-ai/dsh-client-modules', '@deepseek-ai/dsh-client-connection']
  const results = []
  for (const name of names) {
    let requireResolved
    try {
      requireResolved = createRequire(baseUrl).resolve(`${name}/package.json`)
    } catch (error) {
      requireResolved = `ERROR: ${String(error)}`
    }
    let resolved
    try {
      resolved = version === 'v2'
        ? raw.resolveSync(baseUrl, { specifier: name, attributes: {} }).url
        : raw.resolveSync(name, baseUrl, {}).url
    } catch (error) {
      results.push({ name, requireResolved, error: String(error) })
      continue
    }
    let directory = dirname(fileURLToPath(resolved))
    let manifest
    while (true) {
      const candidate = join(directory, 'package.json')
      if (existsSync(candidate)) {
        try {
          if (JSON.parse(readFileSync(candidate, 'utf8')).name === name) {
            manifest = candidate
            break
          }
        } catch {}
      }
      const parent = dirname(directory)
      if (parent === directory) break
      directory = parent
    }
    results.push({ name, requireResolved, resolved, manifest: manifest ?? null })
  }
  return { ok: results.every(result => result.manifest !== null), version, baseUrl, results }
}

async function probeDirent() {
  const presetPackage = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-agent-presets/package.json'))
  const embeddedRoot = join(dirname(presetPackage), 'presets')
  const embedded = await readdir(embeddedRoot, { withFileTypes: true })
  if (embedded.length === 0 || embedded.some(child => typeof child.isDirectory !== 'function')) {
    throw new Error('SEA 内置目录的 readdir Dirent 契约缺失')
  }
  if (!embedded.some(child => child.name === 'standard' && child.isDirectory())) {
    throw new Error('SEA 内置 standard Preset 未被识别为目录')
  }

  const externalRoot = mkdtempSync(resolve(tmpdir(), 'deepshell-sea-dirent-'))
  try {
    await mkdir(join(externalRoot, 'user-preset'))
    await writeFile(join(externalRoot, 'user-preset', 'agent.cordis.yml'), '[]\n')
    await writeFile(join(externalRoot, 'file.txt'), 'ok')
    const external = await readdir(externalRoot, { withFileTypes: true })
    if (!external.some(child => child.name === 'user-preset' && child.isDirectory())) {
      throw new Error('SEA 外部目录的 readdir Dirent 契约异常')
    }
    if (!external.some(child => child.name === 'file.txt' && child.isFile())) {
      throw new Error('SEA 外部文件的 readdir Dirent 契约异常')
    }

    const { discoverPresets, SHIPPED_PRESET_ROOT } = await import('@deepseek-ai/dsh-agent-presets')
    const harnessBase = new URL('.', import.meta.resolve('@deepseek-ai/dsh/package.json')).href
    const presets = await discoverPresets([
      { path: SHIPPED_PRESET_ROOT, trust: 'system' },
      { path: externalRoot, trust: 'user' },
    ], harnessBase)
    if (!presets.some(preset => preset.id === 'standard' && preset.trust === 'system')) {
      throw new Error('SEA 未能发现内置 standard Preset')
    }
    if (!presets.some(preset => preset.id === 'user-preset' && preset.trust === 'user')) {
      throw new Error('SEA 未能发现外部用户 Preset')
    }
  } finally {
    rmSync(externalRoot, { recursive: true, force: true })
  }
  return { ok: true, embeddedEntries: embedded.length }
}

async function probePwshResolution() {
  // 诊断：在 SEA 受控环境中按 DSH 的规则解析 pwsh 可执行文件。
  const pwshLocal = await import('@deepseek-ai/dsh-pwsh-local')
  const candidates = pwshLocal.candidatePwshPaths()
  const resolved = pwshLocal.resolvePwshPath(undefined)
  return {
    ok: true,
    resolved: resolved ?? null,
    candidates: candidates.slice(0, 8),
    pathHasWindowsApps: (process.env.PATH ?? '').includes('WindowsApps'),
    programFiles: process.env.ProgramFiles ?? null,
    systemRoot: process.env.SystemRoot ?? null,
  }
}

async function probeSubprocessChain() {
  // 诊断：在 SEA 内完整走一遍 DSH subprocess provider 链路（含 Windows Job runner），
  // 并与 Node 直接 spawn 对照。场景必须覆盖 pwsh 工具的真实形态：
  // 1) 直接目标（cmd/powershell/pwsh）；
  // 2) 沙箱包装（ctx.sandbox 把命令 argv 包装为 windows-acl runner，再由 Job runner
  //    用原生 CreateProcess 拉起）——该形态没有 PKG_EXECPATH，曾是真机 pwsh 的失败点。
  const results = {}

  // 对照组：Node 直接 spawn
  try {
    const { spawn } = await import('node:child_process')
    results.direct = await new Promise(resolve => {
      const child = spawn('cmd.exe', ['/d', '/s', '/c', 'echo direct-ok'], { env: process.env })
      let out = ''
      let err = ''
      child.stdout.on('data', chunk => { out += chunk })
      child.stderr.on('data', chunk => { err += chunk })
      child.once('error', error => resolve({ error: String(error) }))
      child.once('exit', code => resolve({ code, stdout: out.trim().slice(0, 200), stderr: err.trim().slice(0, 200) }))
    })
  } catch (error) {
    results.direct = { error: String(error) }
  }

  const skipped = {}
  const scenarios = [
    ['cmd', ['cmd.exe', '/d', '/s', '/c', 'echo chain-cmd-ok']],
    ['powershell', ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', '-NoProfile', '-Command', 'Write-Output chain-ps-ok']],
  ]
  // pwsh 按 DSH 的解析规则动态获取，不做机器特定硬编码；解析不到时显式标记不适用。
  const pwshLocal = await import('@deepseek-ai/dsh-pwsh-local')
  const resolvedPwsh = pwshLocal.resolvePwshPath(undefined)
  if (resolvedPwsh === undefined || resolvedPwsh === null) {
    skipped.pwsh = { applicable: false, reason: '未解析到 pwsh 可执行文件', candidates: pwshLocal.candidatePwshPaths().slice(0, 8) }
  } else {
    scenarios.push(['pwsh', [resolvedPwsh, '-NoProfile', '-Command', 'Write-Output chain-pwsh-ok']])
  }
  // 沙箱链：windows-acl runner 的 read-only 形态要求 --temp 在 workspace 之外。
  const workspace = resolve(process.cwd())
  const temp = resolve(tmpdir())
  if (workspace === temp || workspace.startsWith(`${temp}${sep}`)) {
    skipped['sandbox-acl'] = { applicable: false, reason: 'workspace 位于 tmpdir 之下，--temp 必须在其外' }
  } else {
    scenarios.push(['sandbox-acl', [
      process.execPath,
      fileURLToPath(import.meta.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')),
      '--workspace', workspace,
      '--temp', temp,
      '--mode', 'read-only',
      '--', 'cmd.exe', '/d', '/s', '/c', 'echo sandbox-chain-ok',
    ]])
  }

  const runnerLaunch = await import('./node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner-launch-COYGu0Dl.js')
  const spawnSubprocess = runnerLaunch.E ?? runnerLaunch.spawnSubprocess
  const chainResults = { ...skipped }
  for (const [name, argv] of scenarios) {
    try {
      const handle = spawnSubprocess({
        argv,
        cwd: process.cwd(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
        graceMs: 5000,
        env: {},
      })
      const outcome = await handle.done
      const stdoutRead = handle.collected?.stdout?.readFrom(0)
      const stderrRead = handle.collected?.stderr?.readFrom(0)
      chainResults[name] = {
        outcome: JSON.parse(JSON.stringify(outcome ?? null)),
        stdout: (stdoutRead?.text ?? '').trim().slice(0, 200),
        stderr: (stderrRead?.text ?? '').trim().slice(0, 300),
      }
    } catch (error) {
      chainResults[name] = { error: String(error).slice(0, 400) }
    }
  }
  results.chain = chainResults
  results.resolvedPwsh = resolvedPwsh ?? null

  return { ok: true, results }
}

async function probeSelfSpawnScript() {
  // 诊断：模拟 DSH 的内部 self-spawn（spawn(process.execPath, [script])），
  // 验证 pkg 的 PKG_EXECPATH 协议被 SEA entry 正确消费（而不是落入 DSH CLI）。
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { spawn } = await import('node:child_process')
  const directory = await mkdtemp(join(tmpdir(), 'deepshell-selfspawn-'))
  const marker = join(directory, 'marker.txt')
  const script = join(directory, 'worker.cjs')
  await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'self-spawn-ok')\n`)
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const exitCode = await new Promise(resolveExit => child.once('exit', resolveExit))
  let written = null
  try {
    written = (await readFile(marker, 'utf8')).trim()
  } catch {}
  await rm(directory, { recursive: true, force: true })
  return { ok: written === 'self-spawn-ok', exitCode, marker: written, stderr: stderr.slice(0, 300) }
}

async function probeSelfSpawnShapes() {
  // 诊断：验证两条自 spawn 路径的 argv 契约（脚本参数自 argv[2] 起）。
  // 形态 A（原生 CreateProcess）：显式把 PKG_EXECPATH 置为非 execPath 值以绕过 pkg 注入，
  // 等价于 Windows Job runner / windows-acl runner 的原生拉起；
  // 形态 B（pkg child_process）：由 pkg 自动注入 PKG_EXECPATH。
  const script = fileURLToPath(new URL('./sea-probe-argv.mjs', import.meta.url))
  const shapes = [
    ['native', { PKG_EXECPATH: '' }, ['A1', 'A2']],
    ['pkg', {}, ['B1', 'B2']],
  ]
  const results = {}
  for (const [name, env, args] of shapes) {
    results[name] = await new Promise((resolveProbe, reject) => {
      const child = spawn(process.execPath, [script, ...args], {
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      child.once('error', reject)
      child.once('exit', code => {
        let parsed
        try { parsed = JSON.parse(stdout.trim()) } catch {}
        const argv = Array.isArray(parsed?.argv) ? parsed.argv : null
        resolveProbe({
          ok: code === 0 && parsed?.ok === true && argv !== null && JSON.stringify(argv.slice(2)) === JSON.stringify(args),
          code,
          argv,
          stderr: stderr.trim().slice(0, 200),
        })
      })
    })
  }
  return { ok: Object.values(results).every(entry => entry.ok === true), script, results }
}

async function probeMemory() {
  const usage = process.memoryUsage()
  const result = {
    ok: true,
    rssBytes: usage.rss,
    heapTotalBytes: usage.heapTotal,
    heapUsedBytes: usage.heapUsed,
    externalBytes: usage.external,
    arrayBuffersBytes: usage.arrayBuffers,
  }
  try {
    const sea = await import('node:sea')
    const archive = sea.getRawAsset('__pkg_archive__')
    result.archiveBytes = archive.byteLength
  } catch (error) {
    result.archiveError = String(error)
  }
  return result
}

async function runProbe(name) {
  if (!process.pkg) throw new Error('probe 只能在 Enhanced SEA 中运行')
  if (name === 'child') return { ok: true, packaged: true, execPath: process.execPath }
  if (name === 'identity') return { ok: true, packaged: true, entrypoint: process.pkg.entrypoint, execPath: process.execPath }
  if (name === 'worker') return await probeWorker()
  if (name === 'session-worker') return await probeSessionPersistenceWorker()
  if (name === 'self-spawn') return await probeSelfSpawn()
  if (name === 'node-pty') return await probePty()
  if (name === 'sharp') return await probeSharp()
  if (name === 'koffi') return await probeKoffi()
  if (name === 'flock') return await probeFlock()
  if (name === 'require-builtin') return await probeRequireBuiltin()
  if (name === 'client-resolution') return await probeClientResolution()
  if (name === 'dirent') return await probeDirent()
  if (name === 'memory') return await probeMemory()
  if (name === 'pwsh-resolution') return await probePwshResolution()
  if (name === 'subprocess-chain') return await probeSubprocessChain()
  if (name === 'self-spawn-script') return await probeSelfSpawnScript()
  if (name === 'self-spawn-shapes') return await probeSelfSpawnShapes()
  throw new Error(`未知 SEA probe：${name}`)
}

const runnerSelection = process.env.DSH_SUBPROCESS_RUNNER
const probeIndex = process.argv.indexOf('--deepshell-sea-probe')
// pkg self-spawn 协议：pkg 的 patchChildProcess 会给 child_process 子进程注入
// PKG_EXECPATH=<exe>，由 bootstrap 执行被 spawn 的内部脚本（DSH 的 directory-picker
// worker、sandbox entry、web-app 子进程等）。SEA 的 bootstrap 会把 argv[1] 覆盖为
// snapshot 内的 entrypoint，因此真正的脚本位于 argv[2]。
//
// Windows 上还有第二条自 spawn 路径：DSH 的 Windows Job runner（subprocess-local）
// 与 windows-acl sandbox runner 通过原生 CreateProcess（koffi FFI）拉起目标进程，
// 完全绕过 child_process，因此没有 PKG_EXECPATH；该路径的目标固定是快照内的脚本
// （argv[2] 为快照根下的绝对路径）。两条路径在这里统一识别，否则原生路径的子进程
// 会落入 DSH CLI 并报 `error: --profile <name> is required`。
function resolveSelfSpawnScript() {
  const candidate = process.argv[2]
  // 以 '-' 开头的参数是 CLI 标志（例如探针调用 `--deepshell-sea-probe`，pkg 同样会
  // 为其注入 PKG_EXECPATH），必须继续按探针/CLI 分流。
  if (candidate === undefined || candidate === '' || candidate.startsWith('-')) return undefined
  if (process.env.PKG_EXECPATH === process.execPath) return candidate
  const entrypoint = process.pkg?.entrypoint
  if (typeof candidate !== 'string' || typeof entrypoint !== 'string' || !isAbsolute(candidate)) return undefined
  const snapshotRoot = dirname(entrypoint)
  if (!candidate.startsWith(`${snapshotRoot}${sep}`)) return undefined
  try {
    if (!statSync(candidate).isFile()) return undefined
  } catch {
    return undefined
  }
  return candidate
}
const selfSpawnScript = resolveSelfSpawnScript()
if (process.env.PKG_EXECPATH === process.execPath) delete process.env.PKG_EXECPATH
if (selfSpawnScript !== undefined) {
  const { pathToFileURL } = await import('node:url')
  const scriptPath = resolve(selfSpawnScript)
  // 只移除 bootstrap 注入的 entrypoint 占位，脚本路径保留在 argv[1]：Node 约定下脚本
  // 参数自 argv[2] 起（`process.argv.slice(2)`）。快照脚本在导入时 argv[1] 可能被
  // packaging bootstrap 再次覆盖为 entrypoint，两种情况 slice(2) 都得到真实参数。
  process.argv.splice(1, 1)
  try {
    await import(pathToFileURL(scriptPath).href)
  } catch (importError) {
    // CJS 内部脚本（如 worker.cjs）走 require 路径。
    const { createRequire } = await import('node:module')
    createRequire(import.meta.url)(scriptPath)
  }
} else if (runnerSelection !== undefined && runnerSelection !== '') {
  delete process.env.DSH_SUBPROCESS_RUNNER
  const { runSelectedSubprocessRunner } = await import('@deepseek-ai/dsh-subprocess-local/runner')
  await runSelectedSubprocessRunner(runnerSelection)
} else if (probeIndex >= 0) {
  if (process.platform === 'win32') {
    // Windows 的 ConPTY worker/socket 句柄可能阻止事件循环清空；探针是一次性进程，
    // 等待 stdout flush 后显式退出，避免 benchmark 的 execFile 超时。
    let exitCode = 0
    try {
      writeResult(await runProbe(process.argv[probeIndex + 1]))
    } catch (error) {
      console.error(error)
      exitCode = 1
    }
    await new Promise(resolveFlush => process.stdout.write('', resolveFlush))
    process.exit(exitCode)
  }
  writeResult(await runProbe(process.argv[probeIndex + 1]))
} else {
  const { runCli } = await import('./node_modules/@deepseek-ai/dsh/lib/bin.js')
  await runCli()
}
