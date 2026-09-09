import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

function run(executable, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => resolveRun(code ?? 1))
  })
}

async function ownershipRegistryAbsent() {
  const registry = resolve(homedir(), 'Library/Application Support/com.deepshell.agent/runtime-state/ownership.json')
  const deadline = Date.now() + 6_000
  while (Date.now() < deadline) {
    try {
      await access(registry)
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  const record = JSON.parse(await readFile(registry, 'utf8'))
  if (Number.isInteger(record.processGroupId) && record.processGroupId > 1) {
    try {
      process.kill(-record.processGroupId, 0)
    } catch (error) {
      if (error?.code === 'ESRCH') throw new Error('E2E 退出后 ownership registry 未清除')
      throw error
    }
  }
  throw new Error('E2E 退出后仍有登记的 Sidecar 进程组')
}

const wdio = resolve('node_modules/.bin/wdio')
const startedAt = Date.now()
const exitCode = await run(wdio, ['run', 'wdio.conf.ts'])
await ownershipRegistryAbsent()
const logPath = resolve(homedir(), 'Library/Application Support/com.deepshell.agent/logs/app.jsonl')
const events = (await readFile(logPath, 'utf8'))
  .trim().split('\n').map(line => JSON.parse(line))
  .filter(event => event.timestampMs >= startedAt)
const ready = events.find(event => event.event === 'runtime_ready' && event.sidecarInstanceId)
if (!ready) throw new Error('E2E 未观察到本次运行的 runtime_ready 审计事件')
if (!events.some(event => event.event === 'runtime_stopped' && event.sidecarInstanceId === ready.sidecarInstanceId)) {
  throw new Error('E2E 未观察到同一 Sidecar 实例的 runtime_stopped 审计事件')
}
if (events.some(event => event.event === 'startup_failed' || event.event === 'runtime_failed')) {
  throw new Error('E2E 本次运行包含失败审计事件')
}
if (exitCode !== 0) process.exitCode = exitCode
