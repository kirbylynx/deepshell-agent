语言：[English](README.md) | 简体中文

# DeepShell Agent

> A desktop agent powered by DeepSeek Harness.

DeepShell Agent 是一个基于 DeepSeek Harness（DSH）的桌面 Agent 产品。它将官方 DSH Web UI、固定版本 DSH runtime、bundled Node.js、DeepShell 自有 Bundle/Preset 和桌面生命周期管理组合在一起，目标是提供一个开箱即用、可恢复、可打包分发的本地 Agent 工作台。

DeepShell Agent 不重新实现 Agent Runtime，也不 fork 官方 DSH Web UI。它的架构边界是：

> Tauri 管桌面与进程，DSH 官方 Web UI 管基础交互，DSH Runtime 管 Agent，DeepShell 通过官方扩展点形成产品差异。

## 当前状态

当前源码基线版本为基于 `v0.1.0` MVP（Minimum Viable Product，最小可用版本）的 `v0.1.1` 发布硬化基线。

已经纳入源码基线的能力：

- macOS arm64 桌面应用构建与安装镜像生成；
- Windows x64 runtime 资产锁定与平台化路径基线；
- bundled Node.js，无需最终用户安装 Node.js、npm、pnpm 或 DSH；
- pinned official DSH runtime；
- 官方 DSH React Web UI；
- DeepShell 自有 `deepshell-desktop` DSH Bundle；
- `deepshell-coding`、`deepshell-work`、`deepshell-general` 与 legacy `deepshell` Agent Preset；
- DeepSeek 官方 API、OpenAI-compatible API、Responses API 路由能力；
- 官方 `workspace-write` Permission Preset；
- 官方 `credentials-local` 凭据方案；
- DeepSeek Web Search 与公共 HTTP(S) Web Fetch；
- Sidecar 动态端口、token 清理、Ready Gate、进程清理和基础恢复；
- 本地脱敏诊断包、包体积报告、SBOM 基线、漏洞扫描入口和 release staging 自动化；
- E2E/Release 产物安全边界比较。

仍需在正式二进制公开分发前完成：

- Windows x64 真机或 CI 安装包验收；
- Windows WebView2 首次启动、退出和进程树清理验收；
- macOS Developer ID 签名和 Apple notarization；
- Windows code signing；
- release 级许可证/NOTICE 清单复核。

## 主要能力

### Coding Mode

Coding Mode 面向代码 Workspace，复用 DSH 的文件、搜索、Shell、测试、Git、Session 和 Approval 能力，用于代码理解、修改、验证和变更解释。

### General Mode

General Mode 提供通用问答、本地任务和轻量研究入口。`v0.1.1` 中它以 `deepshell-general` Agent Preset 形式落地，并复用官方 DSH Agent Preset UI。

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

正式公开二进制包发布后，用户应优先从 GitHub Releases 下载对应平台的安装包。

当前源码基线的二进制发布门禁尚未全部完成，因此 public repository 主要用于源码公开、架构审查和可复现构建。若你从源码自行构建，请参考本文最后的 “For contributors” 章节。

### macOS 用户

目标平台：

- Apple Silicon Mac；
- macOS 13.0 或更高版本。

正式发布后，macOS 用户应下载 `.dmg`，将 `DeepShell Agent.app` 拖入 Applications 后启动。

当前源码基线尚未完成 Developer ID 签名和 Apple notarization。公开二进制发布前，需要补齐签名、公证和 Gatekeeper 验证。

### Windows 用户

目标平台：

- Windows 10 22H2 或 Windows 11 x64；
- WebView2 Runtime。

正式发布后，Windows 用户应下载 NSIS installer 并按安装向导安装。

当前源码基线已经锁定 Windows x64 runtime 资产，但 Windows installer、WebView2 首次启动、退出和进程树清理仍需在 Windows 真机或 CI 中完成发布验收。

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

需要对外分发二进制包时，应通过 GitHub Releases 或其他发布渠道单独提供 release artifact，并重新生成对应平台的许可证/NOTICE 清单。

## License

DeepShell Agent 源码以 MIT License 发布，详见 [LICENSE](LICENSE)。

第三方依赖、bundled runtime 和二进制发布包中的组件仍遵循各自的 license。发布二进制包前，应重新生成对应平台的许可证/NOTICE 清单、SBOM 和 release staging assets，并随 release artifact 一并提供必要 notices；当前基线见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 文档

- [架构设计](docs/architecture.zh.md)
- [Roadmap](docs/roadmap.zh.md)
- [v0.0.1 POC 收口](docs/releases/v0.0.1.zh.md)
- [v0.1.0 MVP 收口](docs/releases/v0.1.0.zh.md)
- [v0.1.1 发布硬化收口](docs/releases/v0.1.1.zh.md)

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
- Agent Runtime：DeepSeek Harness `0.1.2-rc.1`
- Bundled Node.js：Node.js `24.20.0`
- Package Manager：pnpm `10.30.2`
- Test：Rust test、Vitest、WebdriverIO/Tauri E2E

### 源码构建流程

构建流程分为三步：

1. 安装开发依赖；
2. 准备 bundled runtime 和 DSH Profile；
3. 在目标系统上构建对应平台的应用包。

公开源码仓库不会提交完整 runtime、安装后的依赖树或本地构建产物。首次构建时，脚本会根据 `runtime/manifest/runtime-lock.json` 下载并校验 Node.js runtime，并根据 `runtime/manifest/dsh-install/package-lock.json` 安装锁定版本的 DSH production dependency tree。

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

- Windows 上的 `pnpm package:mvp` 会调用 Tauri 构建 NSIS installer。
- Windows installer、WebView2 首次启动、退出和进程树清理需要在 Windows 真机或 CI 中验收。
- 当前源码基线不包含 Windows code signing；正式二进制分发前需要单独完成。

### 常用开发命令

```bash
pnpm check
pnpm runtime:smoke
pnpm runtime:verify --target all
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
- `pnpm profile:verify` 校验 DeepShell Bundle/Profile/Preset 与官方 DSH 基线的关系；
- `pnpm package:e2e` 构建 E2E 专用应用包并捕获产物清单；
- `pnpm package:mvp` 是平台感知打包脚本：
  - macOS：构建 `.app`、签名、校验并生成 `.dmg`；
  - Windows：在 Windows 构建环境中构建 NSIS installer；
- `pnpm package:verified` 会重建 E2E 和 Release 产物，并执行安全边界比较。
- `pnpm licenses:collect`、`pnpm sbom:generate`、`pnpm package:report` 和 `pnpm release:stage` 用于准备本地 release 支持资产，不会执行发布；
- `pnpm diagnostics:collect` 会在 ignored staging 下导出本地脱敏诊断包；
- `pnpm release:windows:check` 输出 Windows x64 打包路线；在 macOS 上运行时不能被当作 Windows installer 验收通过；
- `pnpm security:audit` 生成漏洞扫描摘要；需要确定性流水线检查时可使用 `pnpm security:audit -- --dry-run`。
