// 免安装 ZIP 打包：从同一 release binary 生成 allowlist staging，压缩后解压复验。
//
// 设计依据：docs/plans/v0.1.4-packaging/design.md §5（staging 安全、ZIP 后端、解压复验）
// 与要求 D-1406（ZIP 布局与命名）。
//
// ZIP 内只有一个顶层 `DeepShell Agent/` 目录：
//   DeepShell Agent/
//   ├── DeepShell Agent.exe
//   ├── runtime/node/win32-x64/
//   ├── runtime/dsh/
//   ├── runtime/profile-template/
//   ├── LICENSE
//   └── README-portable.txt
//
// 安全约束（不得放宽）：
// 1. staging 基准必须位于 `runtime/staging/portable-v<version>`，拒绝指向工作区、
//    用户目录或磁盘根等受保护路径；
// 2. 只复制 allowlist 条目；复制过程拒绝任何符号链接 / junction / reparse point；
// 3. 压缩必须使用参数数组调用 Windows 自带 tar.exe，禁止 shell 字符串拼接；
// 4. 压缩后必须解压到全新目录逐项复验（staging ≡ extracted），复验通过才报告成功。
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, copyFile, lstat, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { readLock, root } from './lib/runtime.mjs'
import { packageAdapter } from './lib/package-platform.mjs'
import { assertEquivalentTrees } from './lib/tree-manifest.mjs'

const execFileAsync = promisify(execFile)

export const PORTABLE_ROOT_NAME = 'DeepShell Agent'

export function portablePaths(packageRoot, version) {
  const stageBase = resolve(packageRoot, 'runtime/staging', `portable-v${version}`)
  return {
    stageBase,
    stagingParent: resolve(stageBase, 'staging'),
    stagingPath: resolve(stageBase, 'staging', PORTABLE_ROOT_NAME),
    extractParent: resolve(stageBase, 'extracted'),
    extractedPath: resolve(stageBase, 'extracted', PORTABLE_ROOT_NAME),
    archivePath: resolve(packageRoot, 'src-tauri/target/release/bundle/portable', `DeepShell.Agent_${version}_x64-portable.zip`)
  }
}

export const portableAllowlist = [
  { target: 'DeepShell Agent.exe', source: 'src-tauri/target/release/deepshell-agent.exe', kind: 'file' },
  { target: 'runtime/node/win32-x64', source: 'runtime/node/win32-x64', kind: 'directory' },
  { target: 'runtime/dsh', source: 'runtime/dsh', kind: 'directory' },
  { target: 'runtime/profile-template', source: 'runtime/profile-template', kind: 'directory' },
  { target: 'LICENSE', source: 'LICENSE', kind: 'file' },
  { target: 'README-portable.txt', source: 'packaging/windows/README-portable.txt', kind: 'file' }
]

export const portableTopLevelEntries = ['DeepShell Agent.exe', 'runtime', 'LICENSE', 'README-portable.txt']

// 顶层条目断言（供单测直接调用）：必须恰好等于 allowlist 目标集合，不允许额外或缺失条目。
export function assertPortableLayout(entries, label = 'portable tree') {
  const expected = [...portableTopLevelEntries].sort()
  const actual = [...entries].sort()
  if (expected.length !== actual.length || expected.some((entry, index) => entry !== actual[index])) {
    throw new Error(`${label} 顶层条目不符合便携布局：expected ${expected.join(', ')}, got ${actual.join(', ')}`)
  }
}

export function assertPortableTargetPath(target) {
  if (target === '' || target.startsWith('/') || /^[A-Za-z]:/.test(target) ||
      target.split('/').some(part => part === '..' || part === '')) {
    throw new Error(`便携 allowlist 目标路径不合法：${target}`)
  }
}

export function assertSafePortableStageBase(stageBase, packageRoot = root) {
  const normalized = resolve(stageBase)
  const protectedPaths = [
    resolve(packageRoot, 'runtime/staging'),
    resolve(packageRoot),
    resolve(process.env.USERPROFILE ?? packageRoot),
    resolve(process.env.APPDATA ?? packageRoot)
  ]
  if (protectedPaths.some(protectedPath => normalized === protectedPath)) {
    throw new Error(`拒绝把 staging 基准指向受保护目录：${normalized}`)
  }
  const stagingRoot = resolve(packageRoot, 'runtime/staging') + sep
  if (!normalized.startsWith(stagingRoot)) {
    throw new Error(`staging 基准必须位于运行时 staging 目录内：${normalized}`)
  }
  if (!/(^|[\\/])portable-v[^\\/]+$/.test(normalized)) {
    throw new Error(`staging 基准必须以 portable-v<version> 结尾：${normalized}`)
  }
}

/// 流式计算文件 sha256（避免把上百 MB 的 ZIP 读入内存）。
async function hashFile(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', reject)
      .on('data', chunk => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

/// 递归复制目录树，拒绝任何符号链接 / junction / reparse point（导出供单测直接验证）。
export async function copyTreeWithoutReparsePoints(sourceDirectory, targetDirectory) {
  const entries = await readdir(sourceDirectory)
  await mkdir(targetDirectory, { recursive: true })
  for (const entry of entries) {
    const source = resolve(sourceDirectory, entry)
    const target = resolve(targetDirectory, entry)
    const metadata = await lstat(source)
    if (metadata.isSymbolicLink()) {
      throw new Error(`便携 staging 拒绝符号链接或 reparse point：${source}`)
    }
    if (metadata.isDirectory()) {
      await copyTreeWithoutReparsePoints(source, target)
      continue
    }
    if (!metadata.isFile()) throw new Error(`便携 staging 不支持的条目类型：${source}`)
    await copyFile(source, target)
  }
}

/// 压缩 staging 并解压到全新目录做逐项复验（导出供单测直接验证）。
///
/// 只接受显式路径：生产调用方使用 `portablePaths()` 的位置约定，测试可用临时目录；
/// 复验包含"ZIP 顶层是单一目录"、便携布局断言与 staging ≡ extracted 等价比较。
export async function packAndVerify({ stagingPath, stagingParent, archivePath, extractParent }) {
  const tarPath = resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe')
  try {
    await access(tarPath)
  } catch {
    throw new Error(`缺少 Windows ZIP 后端（tar.exe）：${tarPath}`)
  }
  const stagingName = basename(stagingPath)
  await mkdir(dirname(archivePath), { recursive: true })
  await execFileAsync(tarPath, ['-a', '-c', '-f', archivePath, '-C', stagingParent, stagingName], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60_000,
  })
  await mkdir(extractParent, { recursive: true })
  await execFileAsync(tarPath, ['-x', '-f', archivePath, '-C', extractParent], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 10 * 60_000,
  })
  const extractedTopLevel = await readdir(extractParent)
  if (extractedTopLevel.length !== 1 || extractedTopLevel[0] !== stagingName) {
    throw new Error(`便携 ZIP 顶层必须是单一目录 ${stagingName}：${extractedTopLevel.join(', ')}`)
  }
  const extractedPath = resolve(extractParent, stagingName)
  assertPortableLayout(await readdir(extractedPath), 'portable extracted tree')
  const equivalence = await assertEquivalentTrees(stagingPath, extractedPath, 'portable staging/extracted')
  return { extractedPath, staging: equivalence.source, extracted: equivalence.target }
}

export async function createWindowsPortable() {
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const version = pkg.version
  const paths = portablePaths(root, version)
  assertSafePortableStageBase(paths.stageBase, root)
  for (const entry of portableAllowlist) assertPortableTargetPath(entry.target)

  const tarPath = resolve(process.env.SystemRoot ?? 'C:/Windows', 'System32/tar.exe')
  try {
    await access(tarPath)
  } catch {
    throw new Error(`缺少 Windows ZIP 后端（tar.exe）：${tarPath}`)
  }

  // 干净重建 staging 与 extracted；ZIP 输出目录位于 release bundle 下。
  await rm(paths.stageBase, { recursive: true, force: true })
  await mkdir(paths.stagingPath, { recursive: true })
  await mkdir(dirname(paths.archivePath), { recursive: true })

  const lock = await readLock()
  const adapter = packageAdapter('win32', lock, 'windows-portable', {
    stagingPath: paths.stagingPath,
    archivePath: paths.archivePath,
    extractedPath: paths.extractedPath
  })

  // 复制前先证明源侧必需项存在，避免产出"压缩成功但内容不全"的 ZIP。
  for (const source of [
    resolve(root, 'src-tauri/target/release/deepshell-agent.exe'),
    resolve(root, 'runtime/node/win32-x64/node.exe'),
    resolve(root, 'runtime/dsh', lock.dsh.entry),
    resolve(root, 'runtime/profile-template/template-manifest.json')
  ]) {
    await access(source)
  }

  for (const entry of portableAllowlist) {
    const source = resolve(root, entry.source)
    const target = resolve(paths.stagingPath, entry.target)
    const metadata = await lstat(source)
    if (metadata.isSymbolicLink()) {
      throw new Error(`便携 staging 拒绝符号链接或 reparse point：${source}`)
    }
    if (entry.kind === 'directory') {
      if (!metadata.isDirectory()) throw new Error(`便携 allowlist 期望目录：${source}`)
      await copyTreeWithoutReparsePoints(source, target)
      continue
    }
    if (!metadata.isFile()) throw new Error(`便携 allowlist 期望文件：${source}`)
    await mkdir(dirname(target), { recursive: true })
    await copyFile(source, target)
  }

  assertPortableLayout(await readdir(paths.stagingPath), 'portable staging')

  // 必需项与禁止项（另一平台 Runtime）以适配器定义为唯一来源。
  for (const relative of adapter.requiredArtifacts) {
    await access(resolve(paths.stagingPath, relative))
  }
  for (const relative of adapter.forbiddenArtifacts) {
    try {
      await access(resolve(paths.stagingPath, relative))
      throw new Error(`便携 staging 包含禁止资源：${relative}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  // 压缩 → 解压 → 复验（顶层目录断言与 staging ≡ extracted 等价比较）。
  const { extractedPath, staging, extracted } = await packAndVerify({
    stagingPath: paths.stagingPath,
    stagingParent: paths.stagingParent,
    archivePath: paths.archivePath,
    extractParent: paths.extractParent
  })
  for (const relative of adapter.forbiddenArtifacts) {
    try {
      await access(resolve(extractedPath, relative))
      throw new Error(`便携解压树包含禁止资源：${relative}`)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const archiveBytes = (await stat(paths.archivePath)).size
  const archiveSha256 = await hashFile(paths.archivePath)
  console.log(JSON.stringify({
    ok: true,
    version,
    stagingPath: paths.stagingPath,
    extractedPath,
    archivePath: paths.archivePath,
    archiveBytes,
    archiveSha256,
    staging: {
      bytes: staging.bytes,
      files: staging.files,
      contentSha256: staging.contentSha256
    },
    extracted: {
      bytes: extracted.bytes,
      files: extracted.files,
      contentSha256: extracted.contentSha256
    }
  }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createWindowsPortable()
}
