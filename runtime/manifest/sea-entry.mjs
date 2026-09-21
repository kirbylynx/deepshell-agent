import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
  return await new Promise((resolveProbe, reject) => {
    const marker = `deepshell-sea-pty-${process.pid}`
    const terminal = spawnPty('/bin/sh', ['-c', `printf ${marker}`], {
      cols: 80,
      rows: 24,
      cwd: tmpdir(),
      env: { PATH: '/usr/bin:/bin' },
    })
    let output = ''
    const timer = setTimeout(() => {
      try { terminal.kill() } catch {}
      reject(new Error('node-pty probe 超时'))
    }, 5_000)
    terminal.onData(data => { output += data })
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer)
      if (exitCode !== 0 || !output.includes(marker)) reject(new Error(`node-pty probe 失败：${exitCode}`))
      else resolveProbe({ ok: true, marker })
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
  const libc = koffi.load('/usr/lib/libSystem.B.dylib')
  const getpid = libc.func('int getpid()')
  const pid = getpid()
  if (pid !== process.pid) throw new Error(`koffi getpid 不一致：${pid}`)
  return { ok: true, pid }
}

async function probeFlock() {
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
  throw new Error(`未知 SEA probe：${name}`)
}

const probeIndex = process.argv.indexOf('--deepshell-sea-probe')
if (probeIndex >= 0) {
  writeResult(await runProbe(process.argv[probeIndex + 1]))
} else {
  const { runCli } = await import('./node_modules/@deepseek-ai/dsh/lib/bin.js')
  await runCli()
}
