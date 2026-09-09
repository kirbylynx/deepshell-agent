import { access, readFile, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { readLock, root } from './lib/runtime.mjs'

const mode = process.argv[2] ?? 'release'
if (!['e2e', 'release'].includes(mode)) throw new Error('用法：verify-package.mjs <e2e|release>')

const lock = await readLock()
const execFileAsync = promisify(execFile)
const app = resolve(root, 'src-tauri/target/release/bundle/macos/DeepShell Agent.app')
const required = [
  'Contents/Info.plist',
  'Contents/MacOS/deepshell-agent',
  'Contents/Resources/runtime/node/darwin-arm64/bin/node',
  'Contents/Resources/runtime/node/win32-x64/node.exe',
  `Contents/Resources/runtime/dsh/${lock.dsh.entry}`,
  'Contents/Resources/runtime/profile-template/template-manifest.json'
]
for (const relative of required) await access(resolve(app, relative))
const plist = await readFile(resolve(app, 'Contents/Info.plist'), 'utf8')
if (!plist.includes('0.1.0')) throw new Error('Info.plist 版本不一致')
if (/isInspectable|poc-e2e|wdio/i.test(plist)) throw new Error('Release Info.plist 含测试配置')
await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
const binary = resolve(app, 'Contents/MacOS/deepshell-agent')
const { stdout: strings } = await execFileAsync('/usr/bin/strings', [binary], { maxBuffer: 64 * 1024 * 1024 })
const expectedMarker = `deepshell-build-profile:${mode === 'e2e' ? 'poc-e2e' : 'release'}`
const forbiddenMarker = `deepshell-build-profile:${mode === 'e2e' ? 'release' : 'poc-e2e'}`
if (!strings.includes(expectedMarker) || strings.includes(forbiddenMarker)) {
  throw new Error(`${mode} binary build profile marker 无效`)
}
if (mode === 'release' && strings.includes('poc_e2e_stop_runtime')) {
  throw new Error('Release binary 包含 E2E Runtime 清理命令')
}
if (mode === 'e2e' && !strings.includes('poc_e2e_stop_runtime')) {
  throw new Error('E2E binary 缺少受限 Runtime 清理命令')
}
const entitlements = await execFileAsync('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', binary])
  .catch(error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
if (/<key>|<dict>/.test(`${entitlements.stdout}${entitlements.stderr}`)) {
  throw new Error('MVP Release 不应携带应用 entitlements')
}

async function scan(path) {
  let count = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name)
    count += entry.isDirectory() ? await scan(child) : 1
  }
  return count
}

async function rejectTestResources(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name)
    const relative = child.slice(app.length + 1)
    if (/wdio|poc-e2e|fake-provider|test-provider/i.test(relative)) {
      throw new Error(`Release 包含测试资源：${relative}`)
    }
    if (entry.isDirectory()) await rejectTestResources(child)
  }
}

await rejectTestResources(resolve(app, 'Contents/Resources'))

console.log(JSON.stringify({ ok: true, app, fileCount: await scan(app), bundledNode: lock.node.version, bundledDsh: lock.dsh.version }))
