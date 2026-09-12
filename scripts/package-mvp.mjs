import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { root } from './lib/runtime.mjs'

// Windows 上 pnpm 是 `pnpm.cmd` 批处理，而 Node 出于安全考虑（CVE-2024-27980）
// 拒绝在未启用 shell 时直接启动 `.cmd`/`.bat` → `spawn EINVAL`。
// 因此经 `cmd.exe /d /s /c` 启动；**不使用** `shell: true`，避免参数拼接引发的 DEP0190 警告。
// Unix 上 pnpm 是可执行脚本，走原路径即可。
function spawnPlan(command, args) {
  if (process.platform === 'win32' && command.endsWith('.cmd')) {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', command, ...args] }
  }
  return { command, args }
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const plan = spawnPlan(command, args)
    const child = spawn(plan.command, plan.args, { stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} 退出码 ${code}`)))
  })
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))

if (process.platform === 'darwin') {
  await run(pnpm, ['exec', 'tauri', 'build', '--bundles', 'app'])
  await run('node', ['scripts/sign-package.mjs'])
  await run('node', ['scripts/verify-package.mjs', 'release'])
  await run('node', ['scripts/create-macos-dmg.mjs'])
  await run('node', ['scripts/capture-package-manifest.mjs', 'release'])
  await run('node', ['scripts/compare-e2e-release.mjs', '--require-artifacts'])
} else if (process.platform === 'win32') {
  await run(pnpm, ['exec', 'tauri', 'build', '--bundles', 'nsis'])
  // Windows 无代码签名（REL-008 未做），故不调用 sign-package.mjs（其硬编码 /usr/bin/codesign）。
  await run('node', ['scripts/verify-package.mjs', 'release'])
  await run('node', ['scripts/capture-package-manifest.mjs', 'release'])
  // 不加 --require-artifacts：Windows 侧没有 E2E 产物清单（`.app` + WDIO 链路仅 macOS），
  // 只做静态安全边界比较；若同时存在另一平台清单，compare 脚本会按平台校验拒绝比较。
  await run('node', ['scripts/compare-e2e-release.mjs'])
} else {
  throw new Error(`DeepShell Agent v${pkg.version} 暂不支持当前打包平台：${process.platform}`)
}
