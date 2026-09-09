import { spawn } from 'node:child_process'

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)))
  })
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

if (process.platform === 'darwin') {
  await run(pnpm, ['exec', 'tauri', 'build', '--bundles', 'app'])
  await run('node', ['scripts/sign-package.mjs'])
  await run('node', ['scripts/verify-package.mjs', 'release'])
  await run('node', ['scripts/create-macos-dmg.mjs'])
  await run('node', ['scripts/capture-package-manifest.mjs', 'release'])
  await run('node', ['scripts/compare-e2e-release.mjs', '--require-artifacts'])
} else if (process.platform === 'win32') {
  await run(pnpm, ['exec', 'tauri', 'build', '--bundles', 'nsis'])
  console.log('Windows NSIS installer built; Windows signing and package-manifest capture are deferred to the Windows release lane.')
} else {
  throw new Error(`v0.1.0 MVP 暂不支持当前打包平台：${process.platform}`)
}
