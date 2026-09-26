语言：[English](README.md) | 简体中文

# DeepShell Agent

> A desktop agent powered by DeepSeek Harness.

DeepShell Agent 是一个基于 DeepSeek Harness（DSH）的桌面 Agent 产品。它将官方 DSH Web UI、固定版本 DSH runtime、bundled Node.js、DeepShell 自有 Bundle/Preset 和桌面生命周期管理组合在一起，目标是提供一个开箱即用、可恢复、可打包分发的本地 Agent 工作台。

DeepShell Agent 不重新实现 Agent Runtime，也不 fork 官方 DSH Web UI。它的架构边界是：

> Tauri 管桌面与进程，DSH 官方 Web UI 管基础交互，DSH Runtime 管 Agent，DeepShell 通过官方扩展点形成产品差异。

## 当前状态

最新已公开发布基线为未签名的 `v0.1.4` preview release。该版本已完成 Windows 11 x64 真机验收与最终 macOS arm64 回归：新增按平台裁剪运行时、Windows portable ZIP、更安全的 Windows 卸载清理和平台原生菜单，同时继续固定使用 DeepSeek Harness `0.1.5-rc.1`，并保持官方 Web UI / 官方扩展点架构不变。

`v0.1.5` release candidate（尚未发布）将解压式 Node.js + DSH 运行时树替换为按平台的单文件 SEA Runtime，并固定使用 DeepSeek Harness `0.1.5-rc.2`。该候选版本已在最终 clean rebuild 产物上完成 Windows x64 W0–W3 验收（含真机工具复测），并完成 macOS arm64 轮次；资产将在 combined release staging 时定稿。详见 [v0.1.5 发布说明](docs/releases/v0.1.5.zh.md)。

已经纳入源码基线的能力：

- macOS arm64 桌面应用构建与安装镜像生成；
- Windows x64 runtime 资产锁定与平台化路径基线；
- bundled Node.js，无需最终用户安装 Node.js、npm、pnpm 或 DSH；
- 按平台的单文件 SEA Runtime（Node.js + DSH 内嵌于单一可执行文件；native addon 物化到受控的按 generation 缓存目录），Release 安装包不再携带解压式运行时树；
- pinned official DSH runtime；
- 官方 DSH React Web UI；
- DeepShell 自有 `deepshell-desktop` DSH Bundle；
- `deepshell-coding`、`deepshell-work`、`deepshell-general` 与 legacy `deepshell` Agent Preset；
- DeepSeek 官方 API、OpenAI-compatible API、Responses API 路由能力；
- 官方 `workspace-write` Permission Preset；
- 官方 `credentials-local` 凭据方案；
- DeepSeek Web Search 与公共 HTTP(S) Web Fetch；
- 通过上游 DSH DeepSeek adapter 兼容 DeepSeek `deepseek-flash` / `DeepSeek-V41-Flash` 模型目录；
- Sidecar 动态端口、token 清理、Ready Gate、进程清理和基础恢复；
- `v0.1.1` 到 `v0.1.2` runtime refresh 期间，对 `dsh-home/sessions` 做有限本地升级前备份；
- 本地脱敏诊断包、包体积报告、SBOM 基线、漏洞扫描入口和 release staging 自动化；
- macOS E2E/Release 产物安全边界比较；
- macOS arm64 与 Windows x64 按平台裁剪运行时打包；
- 已在真实 Windows 11 上验收的 Windows x64 NSIS installer 与 portable ZIP；
- 带安全 Runtime 退出路由的 macOS/Windows 原生菜单。

仍需在正式签名/公证二进制公开分发前完成：

- macOS Developer ID 签名和 Apple notarization；
- Windows code signing；
- 对已生成 license inventory 与 NOTICE 的 release 级法律复核。

`v0.1.3` 已完成（原列于此处的两项）：Windows x64 真机安装包端到端验收、Windows WebView2 首次启动/退出/进程树清理验收，详见 [v0.1.3 收口文档](docs/releases/v0.1.3.zh.md)。

## 主要能力

### Coding Mode

Coding Mode 面向代码 Workspace，复用 DSH 的文件、搜索、Shell、测试、Git、Session 和 Approval 能力，用于代码理解、修改、验证和变更解释。

### General Mode

General Mode 提供通用问答、本地任务和轻量研究入口。它以 `deepshell-general` Agent Preset 形式落地，并复用官方 DSH Agent Preset UI。

### Work Mode

Work Mode 面向通用研究和文本产出，当前 MVP 聚焦：

- Web Search；
- Web Fetch；
- 本地文本/Markdown 文件读写；
- 结构化结果沉淀；
- 会话历史恢复。

Office/PDF/PPTX/XLSX 原生解析、复杂知识库、企业 Connector 和专属文档 UI 暂不属于当前基线范围。

### Model Providers

当前路线支持：

- DeepSeek 官方 API；
- OpenAI-compatible API；
- Responses API。

模型、route、base URL、API Key 和模型列表优先通过官方 DSH Models Settings 管理。DeepShell 不建立第二套模型注册表或凭据系统。

## 获取与运行

对于已发布的二进制包，请使用 GitHub Releases。`v0.1.4` preview release 提供 macOS arm64 DMG、Windows x64 NSIS installer 与 Windows x64 portable ZIP。这些预览资产尚未完成 Developer ID/Apple 公证或 Windows 代码签名。`v0.1.5` 候选版本将两个平台切换为单文件 SEA Runtime；其 Windows x64 NSIS installer 与 portable ZIP 将在 combined release staging 时产出，并适用同样的未签名预览策略。

当前源码基线的正式二进制分发门禁尚未全部完成，因此 public repository 主要用于源码公开、架构审查和可复现构建。若你从源码自行构建，请参考本文最后的 “For contributors” 章节。

### macOS 用户

目标平台：

- Apple Silicon Mac；
- macOS 13.0 或更高版本。

对于已发布的 macOS developer-preview 构建，用户可下载 `.dmg`，将 `DeepShell Agent.app` 拖入 Applications 后启动。

Developer-preview DMG 已为打包流程做本地签名，但尚未完成 Developer ID 签名和 Apple notarization。macOS 可能显示非 notarized 应用的常规安全提示。正式公开二进制分发前，需要补齐签名、公证和 Gatekeeper 验证。

### Windows 用户

目标平台：

- Windows 10 22H2 或 Windows 11 x64；
- WebView2 Runtime（NSIS 安装器已内嵌引导程序，缺少时自动安装）。

Windows 用户可以选择 NSIS installer 或 portable ZIP。portable 版本解压后原地运行，与安装版共用 `%APPDATA%\com.deepshell.agent`，并依赖系统已有 Evergreen WebView2 Runtime。安装版与 portable 版不应并发运行；产品有意保持单实例模型。

`v0.1.4` preview release 已在真实 Windows 11 x64 上完成 WIN-01 至 WIN-13，包括安装版/便携版真实会话创建、跨形态 UI 级 Session 与 Provider 双向共享、删除 portable 目录后保留用户数据、原生菜单目视、孤儿 Sidecar 卸载清理，以及代表性 `v0.1.3` 旧会话升级。详见 [v0.1.4 收口文档](docs/releases/v0.1.4.zh.md)。

`v0.1.5` 候选版本已在最终 clean rebuild 产物上完成 Windows x64 W0–W3 验收：全新安装、`v0.1.4` → `v0.1.5` 升级与 legacy 运行时清理、portable/installed 交替使用、带 SEA proxy 文件的回退、孤儿/卸载 ownership、Windows Defender 扫描、SEA on-device native cache 证据，以及真机工具复测（`read`、`write`、`edit`、`glob`、`grep`、`pwsh`）。详见 [v0.1.5 Windows 交接记录](docs/plans/v0.1.5-sea-runtime/windows-handoff.md)。

**`v0.1.3` 已在真实 Windows x64 真机上完成端到端验收**（安装向导、首次启动、数据目录、凭据配置、会话与工具、单实例、动态端口、恶意源隔离、当时覆盖的退出清理场景、崩溃恢复、诊断包、环境还原）。验收过程中发现并修复了 8 处 Windows 平台缺陷，详见 [v0.1.3 收口文档](docs/releases/v0.1.3.zh.md)。

**以下为已发布 `v0.1.3` 基线如实记录的已知限制**（不作为当前开发分支的“已通过”）：

- **卸载不干净**：后续 Windows 补充测量发现，正常关闭应用和异常终止应用后都曾观测到 Sidecar 孤儿进程。若该孤儿进程仍映射原生库，卸载后安装目录可能残留 5 个文件 / 108.54 MB，需人工终止该进程后删除。该问题未在 `v0.1.3` 修复；`v0.1.4` 已实现并验收 `REL-024` 清理路线；
- **`v0.1.3` 尚未按平台裁剪运行时**：其安装包同时包含 macOS 与 Windows 两套 Node 运行时，其中 macOS 部分（4800 文件 / 187.5 MB）在 Windows 上完全无用。`v0.1.4` 已实现并验收 `REL-022` 的 macOS 与 Windows 路线；
- WebView2 差异矩阵中"字体与中文渲染""文件选择/拖放/剪贴板"两个维度本轮未测；
- 依赖漏洞审计在本机不可用（所配置的 npm 镜像无 audit 端点），**因此未通过漏洞扫描**；
- Windows code signing 未完成。

最终 `v0.1.4` 审计中，production root、bundled DSH Runtime 与 Rust 均为零通告；root 的开发/测试工具链仍有 4 个 high 与 1 个 moderate 告警，按未进入交付 Runtime 的非阻塞构建工具告警记录。

`v0.1.5` 轮次中 Rust 审计完成且零通告；npm 侧审计（`node-root-production`、`node-root-all`、`dsh-runtime`）因所配置的镜像（`registry.npmmirror.com`）不提供 audit 端点（`ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS`）而无法运行，因此**本轮未重新验证** npm 侧通告，v0.1.4 的 npm 侧结果仍是最新可用证据。`pnpm security-audit` 会如实报错，而不会声称通过。

## 使用方式

首次启动后，典型使用流程是：

1. 打开 DeepShell Agent。
2. 在 Models Settings 中配置 DeepSeek 官方 API，或添加 OpenAI-compatible / Responses API Provider。
3. 选择或创建 Workspace。
4. 创建 General、Coding 或 Work Mode Session。
5. 在会话中让 Agent 读取、搜索、修改 Workspace 文件，运行必要命令，或使用 Web Search / Web Fetch 完成研究和文本产出。

## 权限与凭据

DeepShell Agent 默认沿用 DSH 官方 `workspace-write` Permission Preset：

- Workspace 内写入修改按官方权限语义允许；
- Workspace 外写入、扩大权限和危险请求必须走官方 Approval 或 fail closed；
- Shell 命令服从官方 DSH Sandbox/Approval 语义；
- 凭据方案沿用官方 `credentials-local`。

注意：`credentials-local` 不是系统 Keychain。它可以利用本地文件权限隔离不同 OS 用户，但不能被描述为同一 OS 用户进程之间的强安全边界。

## 构建与发布边界

公开源码仓库只保留源码、测试、构建脚本、锁定清单和公开文档。

不提交：

- 完整 runtime；
- 安装后的依赖树；
- 构建缓存；
- 本地 `.app`、`.dmg`、installer；
- E2E 和 release staging manifest；
- 本地验收证据；
- 日志、截图、诊断包或任何真实 Secret。

需要对外分发二进制包时，应通过 GitHub Releases 或其他发布渠道单独提供 release artifact，并重新生成对应平台的许可证/NOTICE 清单、SBOM、package report 和 security audit report。

## License

DeepShell Agent 源码以 MIT License 发布，详见 [LICENSE](LICENSE)。

第三方依赖、bundled runtime 和二进制发布包中的组件仍遵循各自的 license。发布二进制包前，应重新生成对应平台的许可证/NOTICE 清单、SBOM 和 release staging assets，并随 release artifact 一并提供必要 notices；当前基线见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 文档

- [架构设计](docs/architecture.zh.md)
- [Roadmap](docs/roadmap.zh.md)
- [v0.0.1 POC 收口](docs/releases/v0.0.1.zh.md)
- [v0.1.0 MVP 收口](docs/releases/v0.1.0.zh.md)
- [v0.1.1 发布硬化收口](docs/releases/v0.1.1.zh.md)
- [v0.1.2 DSH Runtime Refresh 收口](docs/releases/v0.1.2.zh.md)

`docs/plans/` 是本地过程文档目录，用于需求推演、设计草案、实施计划和验收证据整理，默认不随公开源码仓库发布。

## 品牌与图标

DeepShell Agent 使用独立图标语言：

- 深海蓝圆角方块；
- 高亮青蓝极简扇贝；
- 大号 `>_` terminal prompt；
- 平面化、少拟物，适配现代 macOS / Windows 桌面图标风格。

当前图标资产：

- `src-tauri/icons/app-icon-source.svg`
- `src-tauri/icons/app-icon-source.png`
- `src-tauri/icons/icon.png`
- `src-tauri/icons/icon.icns`
- `src-tauri/icons/icon.ico`

## 与 DeepSeek Harness / DeepSeek 的关系

DeepShell Agent 是基于 DeepSeek Harness 构建的独立桌面 Agent 产品。DeepSeek Harness 提供核心 Agent Runtime、Web UI 和插件机制；DeepShell Agent 负责桌面封装、运行时分发、产品化 Bundle、默认模式、诊断恢复和发布流程。

本项目不是 DeepSeek 官方产品，不表示与 DeepSeek 存在隶属、合作、授权或背书关系。DeepSeek、DeepSeek Harness 及相关名称归其权利人所有；本项目仅为描述技术兼容性和上游依赖关系而使用相关名称。

## For contributors

以下内容面向从源码构建、开发和验证 DeepShell Agent 的贡献者。

### 技术栈

- Desktop Shell：Tauri 2 + Rust
- Web Bootstrap：Vite + TypeScript
- UI Runtime：官方 DSH React Web UI
- Agent Runtime：DeepSeek Harness `0.1.5-rc.2`
- 内嵌 Node.js：Node.js `24.20.0`（Release SEA）；Standard Node runtime 仅保留为开发/验证输入
- Package Manager：pnpm `10.30.2`
- Test：Rust test、Vitest、WebdriverIO/Tauri E2E

### 源码构建流程

构建流程分为三步：

1. 安装开发依赖；
2. 准备锁定的 Standard runtime 输入、DSH Profile 与当前平台 SEA Runtime；
3. 在目标系统上构建对应平台的应用包。

公开源码仓库不会提交完整 runtime、安装后的依赖树、生成的 SEA executable 或本地构建产物。首次构建时，脚本会根据 `runtime/manifest/runtime-lock.json` 下载并校验 Node.js runtime，根据 `runtime/manifest/dsh-install/package-lock.json` 安装锁定版本的 DSH production dependency tree，并构建 Release 包使用的目标平台 SEA。最终用户仍无须安装系统 Node.js。

### macOS arm64 构建

构建环境：

- Apple Silicon Mac；
- macOS 13.0 或更高版本；
- Xcode Command Line Tools；
- Node.js `>=24.0.0`；
- pnpm `10.30.2`；
- Rust `1.96.0`；
- Tauri 2 所需的 macOS 系统依赖。

准备环境：

```bash
xcode-select --install
corepack enable
corepack prepare pnpm@10.30.2 --activate
rustup toolchain install 1.96.0
```

安装项目依赖：

```bash
pnpm install
```

准备 runtime 与 Profile：

```bash
pnpm runtime:prepare --target all
pnpm runtime:verify --target all
pnpm profile:prepare
pnpm profile:verify
```

开发运行：

```bash
pnpm dev
```

构建 macOS `.app`、生成 `.dmg` 并执行当前 macOS release 校验：

```bash
pnpm package:verified
```

说明：

- `pnpm package:verified` 会先构建 E2E 专用 `.app`，再构建 Release `.app` / `.dmg`，并比较两者的安全边界。
- 如果只需要在已有 E2E manifest 的基础上重新打 Release 包，可以运行 `pnpm package:mvp`。
- 本地生成的 `.app` 和 `.dmg` 位于 Tauri 构建输出目录，默认不进入 Git。
- 当前源码基线不包含 Developer ID 签名和 Apple notarization；正式二进制分发前需要单独完成。

### Windows x64 构建

构建环境：

- Windows 10 22H2 或 Windows 11 x64；
- WebView2 Runtime；
- Microsoft C++ Build Tools / Visual Studio Build Tools，包含 MSVC 与 Windows SDK；
- Node.js `>=24.0.0`；
- pnpm `10.30.2`；
- Rust `1.96.0`，使用 MSVC toolchain；
- Tauri 2 所需的 Windows 系统依赖。

准备环境：

```powershell
corepack enable
corepack prepare pnpm@10.30.2 --activate
rustup toolchain install 1.96.0-msvc
rustup default 1.96.0-msvc
```

安装项目依赖：

```powershell
pnpm install
```

准备 runtime 与 Profile：

```powershell
pnpm runtime:prepare --target all
pnpm runtime:verify --target all
pnpm profile:prepare
pnpm profile:verify
```

开发运行：

```powershell
pnpm dev
```

构建 Windows NSIS installer：

```powershell
pnpm package:mvp
```

说明：

- Windows 上的 `pnpm package:mvp` 会调用 Tauri 构建 NSIS installer，产出 release NSIS 产物清单（`runtime/staging/package-release-win32-x64-nsis-installer.json`，`schemaVersion: 6`），并执行 Windows release manifest 的静态安全边界检查。它不会在 Windows 上执行仅属于 macOS 路线的 E2E/Release 产物比较。
- NSIS 工具链**由 Tauri 自动下载**到 `%LOCALAPPDATA%\tauri\NSIS\`，无需单独安装，也无需配置系统 `PATH`；同目录还会缓存 WebView2 引导程序。
- `v0.1.3` 已在真实 Windows x64 真机上完成 Windows installer 流水线的端到端实跑（编译 → makensis → 清单捕获 → 静态边界检查，exit 0），产物 80.41 MB。
- 当前源码基线不包含 Windows code signing；正式二进制分发前需要单独完成。
- 依赖漏洞审计需要可用的 npm audit 端点；若镜像不提供，`pnpm security-audit` 会**如实报错**而不会报告"通过"。

### 常用开发命令

```bash
pnpm check
pnpm runtime:smoke
pnpm runtime:verify --target all
pnpm runtime:sea:verify
pnpm runtime:sea:smoke
pnpm runtime:sea:benchmark
pnpm runtime:sea:plugin
pnpm runtime:sea:on-device
pnpm profile:verify
pnpm package:e2e
pnpm package:mvp
pnpm package:verified
pnpm package:compare
pnpm licenses:collect
pnpm sbom:generate
pnpm package:report
pnpm release:stage
pnpm diagnostics:collect
pnpm release:windows:check
pnpm security:audit
```

说明：

- `pnpm check` 执行格式、Clippy、TypeScript、单元测试、契约测试、集成测试、安全测试和 profile/runtime 校验；
- `pnpm runtime:smoke` 启动真实 DSH Web runtime，验证 loopback、token exchange、CSP、Ready Gate 和品牌插件进入 boot graph；
- `pnpm runtime:verify --target all` 校验 macOS arm64 与 Windows x64 runtime 锁定清单；
- `pnpm runtime:sea:verify` 校验当前平台 SEA executable、build receipt、inventories、锁定 patch 与 source-input digest；
- `pnpm runtime:sea:smoke` 启动当前平台 SEA 并校验真实 DSH Web Ready Gate；`pnpm runtime:sea:benchmark` 在支持的真机环境记录固定的启动/RSS/Native Cache 验收矩阵；
- `pnpm runtime:sea:plugin` 在没有系统 Node.js runtime 的条件下验证官方外部 Plugin 的发现、禁用、运行期错误隔离、加载失败 fail-closed（关闭失败）及重启恢复路线；
- `pnpm runtime:sea:on-device` 在真机成功启动后记录当前 SEA generation 已校验的 Native Addon Cache 与控制文件占用；
- `pnpm profile:verify` 校验 DeepShell Bundle/Profile/Preset 与官方 DSH 基线的关系；
- `pnpm package:e2e` 构建 E2E 专用应用包并捕获产物清单；
- `pnpm package:mvp` 是平台感知打包脚本：
  - macOS：构建 `.app`、签名、校验并生成 `.dmg`，捕获 release manifest，并要求 E2E/Release 产物比较通过；
  - Windows：在 Windows 构建环境中构建 NSIS installer，捕获 release NSIS manifest，并执行静态安全边界检查；
- `pnpm package:verified` 会在 macOS release 路线上重建 E2E 和 Release 产物，并执行安全边界比较。
- `pnpm licenses:collect`、`pnpm sbom:generate`、`pnpm package:report` 和 `pnpm release:stage` 用于准备本地 release 支持资产，不会执行发布；
- `pnpm diagnostics:collect` 会在 ignored staging 下导出本地脱敏诊断包；
- `pnpm release:windows:check` 输出 Windows x64 打包路线；在 macOS 上运行时不能被当作 Windows installer 验收通过；
- `pnpm security:audit` 生成漏洞扫描摘要；需要确定性流水线检查时可使用 `pnpm security:audit -- --dry-run`。
