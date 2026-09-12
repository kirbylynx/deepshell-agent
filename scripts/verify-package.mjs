// 产物内容验证（macOS `.app` / Windows NSIS 安装包）。
//
// 平台差异由 `scripts/lib/package-platform.mjs` 提供，本脚本只保留单一检查流程。
// macOS 专属检查（Info.plist ×2 / codesign / entitlements）仅在 darwin 分支执行，
// 其余检查两个平台共用（设计 §4.9 的 7 项清单）。
import { access, readFile, readdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { readLock, root } from './lib/runtime.mjs'
import { packageAdapter, requireArtifactReady } from './lib/package-platform.mjs'

const mode = process.argv[2] ?? 'release'
if (!['e2e', 'release'].includes(mode)) throw new Error('用法：verify-package.mjs <e2e|release>')

const lock = await readLock()
const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const execFileAsync = promisify(execFile)
const adapter = packageAdapter(process.platform, lock)

// 必需文件清单：路径基准与内容均由适配器按平台提供（设计 §4.9 末表要求参数化）。
// darwin 分支保持改造前的两条动作（逐条 access 后读 Info.plist），不新增提前中止；
// win32 分支额外做「尚未打包」与「产物损坏」的区分报告。
async function requireArtifacts() {
  for (const relative of adapter.requiredArtifacts) {
    await access(resolve(adapter.requiredArtifactsBase, relative))
  }
  if (adapter.platform === 'win32') await requireArtifactReady(adapter, access)
  const artifact = await stat(adapter.artifactPath)
  if (artifact.isFile() && artifact.size === 0) throw new Error(`产物为空文件：${adapter.artifactPath}`)
}

// 扫描包含测试资源标记的条目，返回 { path, fragment } 列表。
// 标记词表与改造前一致：/wdio|poc-e2e|fake-provider|test-provider/i
async function findTestResources(path, base) {
  const hits = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name)
    const relative = child.slice(base.length + 1)
    const fragment = relative.match(/wdio|poc-e2e|fake-provider|test-provider/i)
    if (fragment) hits.push({ path: relative, fragment: fragment[0] })
    if (entry.isDirectory()) hits.push(...await findTestResources(child, base))
  }
  return hits
}

await requireArtifacts()

if (adapter.platform === 'darwin') {
  const plist = await readFile(resolve(adapter.artifactPath, 'Contents/Info.plist'), 'utf8')
  if (!plist.includes(rootPackage.version)) throw new Error('Info.plist 版本不一致')
  if (/isInspectable|poc-e2e|wdio/i.test(plist)) throw new Error('Release Info.plist 含测试配置')
  await execFileAsync('/usr/bin/codesign', ['--verify', '--deep', '--strict', adapter.artifactPath])
}

// build profile marker 校验：darwin 用 /usr/bin/strings，win32 用 Node 字节搜索，
// 判定逻辑同构（设计 §4.5 / §4.9 第 5、6 项）。
const expectedMarker = `deepshell-build-profile:${mode === 'e2e' ? 'poc-e2e' : 'release'}`
const forbiddenMarker = `deepshell-build-profile:${mode === 'e2e' ? 'release' : 'poc-e2e'}`
const binaryMarkerText = adapter.platform === 'darwin'
  ? (await execFileAsync('/usr/bin/strings', [adapter.binaryPath], { maxBuffer: 64 * 1024 * 1024 })).stdout
  : adapter.readBinaryStrings(adapter.binaryPath)
if (!binaryMarkerText.includes(expectedMarker) || binaryMarkerText.includes(forbiddenMarker)) {
  throw new Error(`${mode} binary build profile marker 无效`)
}
if (mode === 'release' && binaryMarkerText.includes('poc_e2e_stop_runtime')) {
  throw new Error('Release binary 包含 E2E Runtime 清理命令')
}
if (mode === 'e2e' && !binaryMarkerText.includes('poc_e2e_stop_runtime')) {
  throw new Error('E2E binary 缺少受限 Runtime 清理命令')
}

if (adapter.platform === 'darwin') {
  const entitlements = await execFileAsync('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', adapter.binaryPath])
    .catch(error => ({ stdout: error.stdout ?? '', stderr: error.stderr ?? '' }))
  if (/<key>|<dict>/.test(`${entitlements.stdout}${entitlements.stderr}`)) {
    throw new Error('MVP Release 不应携带应用 entitlements')
  }
} else if (adapter.signing.status !== 'unsigned') {
  throw new Error(`Windows 产物签名状态意外：${adapter.signing.status}`)
}

// 「测试资源不得进入产物」检查。截断基准取适配器的 intermediateRoot（不再硬编码 app 路径长度）：
// macOS 上它是产物内的 `Contents/Resources`；Windows 上它是 NSIS **构建中间目录**（语义近似，
// 见 `package-platform.mjs` 的实测③声明）。
const scanRoot = adapter.intermediateRoot
const resourceHits = await findTestResources(scanRoot, scanRoot)
if (adapter.platform === 'darwin') {
  if (resourceHits.length > 0) throw new Error(`Release 包含测试资源：${resourceHits[0].path}`)
} else if (resourceHits.length > 0) {
  // 降噪要求（设计 §4.4）：逐条输出「命中文件 + 命中片段」，供人工判定；
  // 该结论只能表述为「NSIS 构建中间目录的近似检查」，不等价于 macOS 的严格资源树扫描。
  const details = resourceHits.map(hit => `  ${hit.path}  ← 命中片段 "${hit.fragment}"`).join('\n')
  throw new Error(`NSIS 构建中间目录含测试资源标记（近似检查，需人工判定）：\n${details}`)
}

// 统计产物内的文件数。macOS 的 `.app` 是目录（递归计数）；Windows 的主产物是**单个安装包文件**
// （计数 1）——不区分会导致 `readdir` 对文件抛 ENOTDIR（P6 实测）。
async function scan(path) {
  const metadata = await stat(path)
  if (metadata.isFile()) return 1
  let count = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = resolve(path, entry.name)
    count += entry.isDirectory() ? await scan(child) : 1
  }
  return count
}

console.log(JSON.stringify({
  ok: true,
  platform: adapter.runtimePlatform(),
  artifactPath: adapter.artifactPath,
  fileCount: await scan(adapter.artifactPath),
  bundledNode: lock.node.version,
  bundledDsh: lock.dsh.version
}))
