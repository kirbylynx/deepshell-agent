import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { root } from './lib/runtime.mjs'

const execFileAsync = promisify(execFile)
const app = resolve(root, 'src-tauri/target/release/bundle/macos/DeepShell Agent.app')
await access(app)
await execFileAsync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app])
await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
console.log('MVP .app 已完成 ad-hoc 深度签名并通过校验')
