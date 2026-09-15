import { spawn } from 'node:child_process'
import { platformInputDigest } from './lib/source-inputs.mjs'
import { currentRuntimePlatform, root } from './lib/runtime.mjs'
import { packageCommandPlan } from './lib/process-plan.mjs'

const mode = process.argv[2]
if (!['e2e', 'release'].includes(mode)) throw new Error('用法：build-package.mjs <e2e|release>')
const runtimePlatform = currentRuntimePlatform()
const sourceInputSha256 = await platformInputDigest(root, runtimePlatform)
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const bundles = process.platform === 'darwin' ? 'app' : 'nsis'
const args = ['exec', 'tauri', 'build', '--bundles', bundles]
if (mode === 'e2e') args.push('--features', 'poc-e2e')
const plan = packageCommandPlan(pnpm, args)

await new Promise((resolveRun, reject) => {
  const child = spawn(plan.command, plan.args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, DEEPSHELL_SOURCE_INPUT_SHA256: sourceInputSha256 },
  })
  child.once('error', reject)
  child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`tauri build 退出码 ${code}`)))
})
console.log(`package binary source receipt: ${runtimePlatform}:${sourceInputSha256}`)
