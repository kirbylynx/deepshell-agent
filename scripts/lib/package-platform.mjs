// 产物平台适配层：为 macOS `.app` 与 Windows NSIS 安装包提供统一抽象。
//
// 设计依据：docs/plans/v0.1.3-windows-acceptance/design.md §4.3–§4.9
//
// 三条硬约束（改动时不得违反）：
// 1. `packageAdapter()` 必须是**同步函数**（返回普通对象、不含 Promise）。
//    现有调用方是「模块顶层算路径常量 → 之后 await 各检查」的结构，适配器若为 async
//    会强迫改为顶层 await，属结构性改动、会扩大 diff 面（设计 §4.3 要点 4）。
// 2. **两种「平台」取值不可混用**（设计 §4.3 要点 5）：
//    - `process.platform`（`'darwin'` / `'win32'`）只用于内部分支判据；
//    - 写入产物清单的 `platform` 字段必须取 `currentRuntimePlatform()`
//      （`'darwin-arm64'` / `'win32-x64'`），与 `runtime-lock.json` 的平台命名一致。
// 3. macOS 分支的路径与 `requiredArtifacts`（6 条）与改造前**逐字一致**，
//    M4（macOS 能力未削弱）的举证依赖这一点（设计 §4.9）。
//
// ⚠️ P6（首次真实 Windows 打包）实测纠正了设计阶段的 4 处路径/语义假设，逐条标注在下方。
import { accessSync, constants, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { currentRuntimePlatform, root } from './runtime.mjs'

const MACOS_APP = 'src-tauri/target/release/bundle/macos/DeepShell Agent.app'
// ⚠️ 实测①（P6）：cargo 的二进制名取自 **crate 名**（`deepshell-agent`），**不是** `productName`。
// `tauri build` 实际输出 `target/release/deepshell-agent.exe`；安装后的可执行文件名才由
// `productName`（"DeepShell Agent"）决定。设计 §4.3 原先写作 `DeepShell Agent.exe`，已按实测纠正。
const WINDOWS_BINARY = 'src-tauri/target/release/deepshell-agent.exe'
// 安装包（主产物）的输出目录。
const WINDOWS_NSIS_DIRECTORY = 'src-tauri/target/release/bundle/nsis'
// ⚠️ 实测②（P6）：tauri-bundler 的 NSIS **构建中间目录**在 `target/release/nsis/<arch>/`，
// **不在** `bundle/nsis/x64/`（后者只是安装包的输出目录）。实施计划 P4 步骤 1 假设的
// `bundle/nsis/x64/` 经实测不存在，故按该步骤的回退说明改用实测路径。
const WINDOWS_NSIS_WORK_DIRECTORY = 'src-tauri/target/release/nsis/x64'

// 用同步探测决定 Windows 主二进制位置，避免凭空假设目录形态（设计 §4.4 / 实施计划 P4 步骤 1）。
// Tauri 2 在目标三元组等于宿主三元组时把二进制放在 `target/release/`，跨架构构建时才落到
// `target/<triple>/release/`；此处按顺序取第一个存在的候选，两个都不存在时返回首选路径，
// 由调用方的 access 检查报出明确的「文件不存在」错误（而不是在这里抛错）。
function windowsBinaryPath() {
  const candidates = [
    WINDOWS_BINARY,
    'src-tauri/target/x86_64-pc-windows-msvc/release/deepshell-agent.exe'
  ]
  for (const candidate of candidates) {
    try {
      accessSync(resolve(root, candidate), constants.F_OK)
      return resolve(root, candidate)
    } catch {
      continue
    }
  }
  return resolve(root, WINDOWS_BINARY)
}

// Windows NSIS 构建中间目录：`installer.nsi`、语言文件、`FileAssociation.nsh` 等在此生成。
//
// ⚠️ 语义近似声明（设计 §4.4）：NSIS 安装包是**单个压缩 exe，没有可遍历的资源树**。
// 对该中间目录的扫描**不能证明压缩包内部内容**，因此 `verify-package.mjs` 的
// 「测试资源不得进入 Release」检查在 Windows 上只能表述为「NSIS 构建中间目录的近似检查」，
// **禁止**表述为与 macOS `rejectTestResources` 严格等价。
function windowsIntermediateRoot() {
  const candidates = [
    WINDOWS_NSIS_WORK_DIRECTORY,
    'src-tauri/target/release/nsis',
    'src-tauri/target/release/bundle/nsis/x64'
  ]
  for (const candidate of candidates) {
    const path = resolve(root, candidate)
    try {
      accessSync(path, constants.F_OK)
      return path
    } catch {
      continue
    }
  }
  return resolve(root, WINDOWS_NSIS_DIRECTORY)
}

// 主产物 = 安装包文件（发布资产）。Tauri 的安装包文件名含版本号与架构标记，
// 其分隔符形态以实测为准（实施计划 P6 步骤 1），因此这里**不硬编码文件名**，
// 而是在 NSIS 产物目录中查找 `*-setup.exe`。
// 恰好一个候选时返回该文件；否则退回目录本身（此时 `verify-package.mjs` 会如实报出
// 「安装包尚未产出」，而不是给出误导性的单文件错误）。
function windowsArtifactPath() {
  const directory = resolve(root, WINDOWS_NSIS_DIRECTORY)
  try {
    const installers = readdirSync(directory)
      .filter(name => name.toLowerCase().endsWith('-setup.exe'))
      .sort()
    if (installers.length === 1) return resolve(directory, installers[0])
  } catch {
    // 目录不存在 → 尚未构建，退回目录路径由调用方报告
  }
  return directory
}

// ⚠️ 实测③（P6）：Windows 的「打包资源」语义与 macOS **不同**，必须区分两个概念：
//
// | 概念 | macOS | Windows |
// |---|---|---|
// | 打包资源的**基准目录**（`runtime/...` 相对它解析） | `.app/Contents/Resources/`（产物**内部**） | 仓库根 `root`（打包的**输入**：`<root>/runtime/...`） |
// | 可遍历的"资源树"（测试资源近似扫描） | 同上，**在产物内** | **不存在**——安装包是单个压缩 exe；只能用构建中间目录近似 |
//
// 注意该字段是**基准目录**而非资源目录本身：调用方按 `resolve(resourcesRoot, 'runtime/…')` 使用，
// 因此 Windows 侧必须返回 `root` 而不是 `<root>/runtime`——否则会拼出 `<root>/runtime/runtime/…`
// 而报 ENOENT（P6 实测）。
function windowsStagedResources() {
  return root
}

// 二进制标记搜索（设计 §4.5）：读取二进制字节并做**精确子串**匹配，
// 替代 macOS 的 `/usr/bin/strings`。约束：不得使用正则或模糊匹配，避免误判。
//
// 依据 `src-tauri/src/lib.rs`：`&'static str` 字面量位于只读数据段，可用字节搜索命中。
// 返回值为完整内容字符串以保持与 `strings` 输出同构的「包含性判断」语义。
function readBinaryStrings(path) {
  return readFileSync(path).toString('latin1')
}

function darwinAdapter(lock) {
  return {
    platform: 'darwin',
    runtimePlatform: currentRuntimePlatform,
    artifactKind: 'macos-app',
    artifactPath: resolve(root, MACOS_APP),
    // macOS 上「打包资源」与「可遍历资源树」是**同一个**目录（都在产物内部）。
    resourcesRoot: resolve(root, MACOS_APP, 'Contents/Resources'),
    intermediateRoot: resolve(root, MACOS_APP, 'Contents/Resources'),
    binaryPath: resolve(root, MACOS_APP, 'Contents/MacOS/deepshell-agent'),
    // 与改造前 `scripts/verify-package.mjs` 的 `required` 数组逐字一致（M4 举证①要求 0 差异）：
    // 5 条字面量 + 1 条由 `lock.dsh.entry` 拼出的 DSH 入口，共 6 条。
    requiredArtifacts: [
      'Contents/Info.plist',
      'Contents/MacOS/deepshell-agent',
      'Contents/Resources/runtime/node/darwin-arm64/bin/node',
      'Contents/Resources/runtime/node/win32-x64/node.exe',
      `Contents/Resources/runtime/dsh/${lock.dsh.entry}`,
      'Contents/Resources/runtime/profile-template/template-manifest.json'
    ],
    requiredArtifactsBase: resolve(root, MACOS_APP),
    signing: { status: 'signed-adhoc' },
    linkedLibraries: { status: 'available', tool: '/usr/bin/otool' },
    readBinaryStrings
  }
}

function windowsAdapter() {
  return {
    platform: 'win32',
    runtimePlatform: currentRuntimePlatform,
    artifactKind: 'nsis-installer',
    // 主产物 = 安装包文件（发布资产）；主二进制 = 安装前的真实 exe，两者不同（设计 §4.3）。
    artifactPath: windowsArtifactPath(),
    // 打包资源（打包输入）——用于读取 `template-manifest.json` 等清单输入。
    resourcesRoot: windowsStagedResources(),
    // 测试资源"近似检查"的目标——构建中间目录（见上方实测③的语义声明）。
    intermediateRoot: windowsIntermediateRoot(),
    binaryPath: windowsBinaryPath(),
    // 主产物的检查项为「安装包存在、可读、非空」，由 `verify-package.mjs` 的
    // 产物检查负责；此处只声明相对主二进制的清单，避免同一事实有两处来源。
    requiredArtifacts: [],
    requiredArtifactsBase: null,
    // REL-008 未做代码签名 → 如实标注 unsigned，而不是静默跳过（设计 §4.5）。
    signing: { status: 'unsigned' },
    // `otool -L` 结构性不可得（设计 §4.5）→ 显式 unavailable + 原因，而非空数组。
    linkedLibraries: { status: 'unavailable', reason: 'otool is macOS-only' },
    readBinaryStrings
  }
}

// `lock` 仅 darwin 分支需要（用于拼出 DSH 入口路径）。传入而非在模块内 `await readLock()`，
// 是为了保持本函数同步（硬约束 1）。
export function packageAdapter(platform = process.platform, lock) {
  if (platform === 'darwin') return darwinAdapter(lock)
  if (platform === 'win32') return windowsAdapter()
  throw new Error(`暂不支持的打包平台：${platform}`)
}

// 产物就绪检查：把「尚未打包」与「产物损坏」两类情况分开如实报告，
// 避免调用方在读取二进制时抛出裸 ENOENT（对使用者无指导意义）。
//
// ⚠️ 仅用于 Windows 分支。darwin 分支保持改造前的失败顺序（先报缺失的必需文件、
// 再报 Info.plist），不得因此提前中止而改变 macOS 侧的行为（M4 约束）。
export async function requireArtifactReady(adapter, access) {
  try {
    await access(adapter.artifactPath)
  } catch {
    throw new Error(`产物不存在：${adapter.artifactPath}（请先完成本平台打包）`)
  }
  // Windows 分支在安装包尚未产出时会退回 NSIS 目录，此时目录存在但主产物不是文件。
  if (adapter.artifactKind === 'nsis-installer' && adapter.artifactPath === resolve(root, WINDOWS_NSIS_DIRECTORY)) {
    throw new Error(`NSIS 安装包尚未产出：${adapter.artifactPath} 下未找到 *-setup.exe（请先完成本平台打包）`)
  }
  try {
    await access(adapter.binaryPath)
  } catch {
    throw new Error(`主二进制不存在：${adapter.binaryPath}（请先完成本平台打包）`)
  }
}
