import { execFile } from 'node:child_process'
import { access, readFile, stat, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { root, sha256 } from './lib/runtime.mjs'

const execFileAsync = promisify(execFile)
const app = resolve(root, 'src-tauri/target/release/bundle/macos/DeepShell Agent.app')
const runtimeDirectory = resolve(app, 'Contents/Resources/runtime/sea/darwin-arm64')
const sea = resolve(runtimeDirectory, 'deepshell-runtime')
const manifestPath = resolve(runtimeDirectory, 'sea-runtime-manifest.json')
await access(app)
await Promise.all([access(sea), access(manifestPath)])

// 先签嵌套 SEA，再把签名后的最终摘要写入 runtime manifest。最外层签名不得使用
// `--deep`，否则 codesign 可能递归改写已记录摘要的嵌套可执行文件。
await execFileAsync('/usr/bin/codesign', ['--force', '--sign', '-', sea])
const [manifestSource, seaStat, seaSha256] = await Promise.all([
  readFile(manifestPath, 'utf8'),
  stat(sea),
  sha256(sea),
])
const manifest = JSON.parse(manifestSource)
if (manifest.schemaVersion !== 1 || manifest.runtimeFormat !== 'enhanced-sea' || manifest.platform !== 'darwin-arm64') {
  throw new Error('包内 SEA runtime manifest 版本、格式或平台无效')
}
manifest.finalizedForPackage = true
manifest.executable = {
  file: 'deepshell-runtime',
  bytes: seaStat.size,
  sha256: seaSha256,
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

await execFileAsync('/usr/bin/codesign', ['--force', '--sign', '-', app])
await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
if (await sha256(sea) !== seaSha256) throw new Error('最外层 .app 签名改写了已最终化的 SEA executable')
console.log(JSON.stringify({ ok: true, app, seaSha256, seaBytes: seaStat.size, nestedFirst: true }))
