import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { root } from './lib/runtime.mjs'

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`${command} 退出码 ${code}`)))
  })
}

if (process.platform !== 'darwin') {
  throw new Error('create-macos-dmg.mjs 只能在 macOS 执行')
}

const app = resolve(root, 'src-tauri/target/release/bundle/macos/DeepShell Agent.app')
const outputDirectory = resolve(root, 'src-tauri/target/release/bundle/dmg')
const output = resolve(outputDirectory, 'DeepShell Agent_0.1.0_aarch64.dmg')
const staging = await mkdtemp(resolve(tmpdir(), 'deepshell-dmg-'))

try {
  await mkdir(outputDirectory, { recursive: true })
  await cp(app, resolve(staging, basename(app)), { recursive: true, dereference: true })
  await symlink('/Applications', resolve(staging, 'Applications'))
  await rm(output, { force: true })
  await run('/usr/bin/hdiutil', [
    'create',
    '-volname',
    'DeepShell Agent',
    '-srcfolder',
    staging,
    '-ov',
    '-format',
    'UDZO',
    output
  ])
  console.log(`macOS DMG created: ${output}`)
} finally {
  await rm(staging, { recursive: true, force: true })
}
