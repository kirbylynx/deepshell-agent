语言：[English](architecture.md) | 简体中文

# DeepShell Agent 架构设计

> **Tagline:** A desktop agent powered by DeepSeek Harness.
>
> **状态：** V1 架构基线（Architecture Baseline）
>
> **日期：** 2026-09-06
>
> **适用范围：** V1 产品开发、POC、打包与发布
>
> **上游依赖：** DeepSeek Harness（下文简称 DSH）开发者预览版

本文中的 V1 指从 `v0.1.0` 开始的 MVP 架构基线；`v0.0.x` 为 POC 可行性验证阶段，公开收口结论见 [`docs/releases/v0.0.1.zh.md`](releases/v0.0.1.zh.md)。`docs/plans/` 为本地过程文档目录，默认不随公开源码仓库发布。

## 1. 文档目的

本文定义 DeepShell Agent V1 的系统边界、组件职责、进程与通信拓扑、安全模型、数据归属、打包发布方式和架构验收门槛。实现可以在不破坏这些边界的前提下演进；任何改变进程拓扑、信任边界、持久化归属或 DSH 集成方式的变更，都必须先形成 Architecture Decision Record（ADR，架构决策记录）。

本文中的架构决策分为三种状态：

- **已确定：** 可直接指导实现。
- **POC 门禁：** 方向已确定，但必须用锁定版本的源码和可运行产物验证后才能进入正式开发。
- **延后：** 不属于 V1，不应提前建设。

## 2. 产品定位

DeepShell Agent 是一个以 DSH 为 Agent Kernel（智能体内核）、以官方 DSH Web UI 为 Web Client 的桌面应用。产品价值集中在：

- 原生桌面体验；
- General、Coding、Work 三种面向用户的工作模式；
- 清晰、安全、可恢复的本地工具执行体验；
- 自有 Skills、文档能力和企业工作流；
- 可控的模型、MCP 和扩展能力。

DeepShell Agent 不重新实现通用 Agent Framework，也不维护平行 Web Client。核心分工为：

> **Tauri 管桌面与进程，DSH 官方 Web UI 管基础交互，DSH Runtime 管 Agent，DeepShell 通过官方扩展点形成产品差异。**

## 3. 核心架构决策

| 编号 | 决策 | 状态 |
|---|---|---|
| ADR-001 | 使用 Tauri 2 + Rust 作为 Desktop Shell | 已确定 |
| ADR-002 | 直接复用官方 DSH Web UI；差异化界面使用 TypeScript + React 的 DSH Client/UI Plugin | 已确定 |
| ADR-003 | 使用随应用分发的 Node.js 运行固定版本 DSH，最终用户无须安装 Node/npm/pnpm | 已确定 |
| ADR-004 | 使用 DSH Agent Runtime，不自研第二套 Session、Tool、Skill、Sandbox、Approval 或 Attachment Runtime | 已确定 |
| ADR-005 | Rust 不进入模型工具执行链，只负责桌面能力和 DSH Sidecar 生命周期 | 已确定 |
| ADR-006 | DSH Host 在回环地址上托管官方 Web UI 和 API，使 UI 与 DSH API 同源 | POC 门禁 |
| ADR-007 | 不 fork 官方 Web UI、不修改 DOM、不导入私有 React 实现；只使用 DSH 公开 Plugin、Slot、Service、Profile 和 Bundle 契约 | 已确定 |
| ADR-008 | 一个应用级 DSH Profile；General/Coding/Work 映射为按 Session 选择的 DSH Agent Preset，React Plugin 只负责入口与展示 | 已确定 |
| ADR-009 | 外部 SaaS 优先经 MCP 接入；高权限扩展仅允许 First-party Plugin 和用户显式配置的 MCP Server | 已确定 |
| ADR-010 | 应用、Node、DSH、First-party Plugin 作为一个签名版本单元原子升级 | 已确定 |
| ADR-011 | POC 与 V1 使用 DSH 官方 credentials-local；系统 Keychain/Credential Manager Provider 延后 | 已确定 |

这里的“Full DSH”指完整保留所选官方运行组合所需的核心能力与依赖，不代表默认安装或启用所有 Provider、实验包和第三方 Plugin。构建产物必须最小权限启用，不能把“完整依赖”误解为“全部能力同时暴露给模型”。

## 4. 系统上下文

```text
┌──────────────┐
│     User     │
└──────┬───────┘
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│                    DeepShell Agent                       │
│                                                          │
│  Tauri Desktop Shell                                     │
│     └─ Official DSH Web UI                               │
│          + DeepShell Client/UI Plugins                   │
│                         │                                │
│                         ▼                                │
│                  DSH Host / Agent Runtime                 │
└──────────────────┬───────────────┬──────────────┬─────────┘
                   │               │              │
                   ▼               ▼              ▼
              Local OS         Model APIs      MCP Servers
            FS / Shell / Git   / Web APIs      / SaaS / DB
```

系统有三个主要信任域：

1. **Tauri 主进程：** 可信桌面控制面，拥有窗口和 Sidecar 生命周期权限。
2. **DSH Host：** 高权限 Agent 执行面，按用户授权访问 Workspace、Shell、网络和凭据。
3. **WebView Renderer：** 按潜在不可信前端处理；即使 UI 来自签名安装包，也必须防范 XSS、恶意文档内容和间接 Prompt Injection（提示注入）。

模型输出、网页、附件、Workspace 文件和 MCP 返回值都属于不可信输入，不能因为由 Agent 展示就进入桌面可信域。

## 5. 运行时拓扑

### 5.1 进程模型

V1 至少包含两个长期运行进程：

```text
DeepShell Agent (Tauri/Rust)
└── Node.js Sidecar
    └── DSH Host
        └── 按需启动的工具子进程（Shell、MCP stdio 等）
```

职责如下：

| 进程 | 职责 | 禁止承担的职责 |
|---|---|---|
| Tauri/Rust | 单实例、窗口、菜单、托盘、通知、更新、Sidecar 监管、最小原生对话框 | Agent Loop、工具代理、Session 业务状态、第二套权限判断 |
| WebView/DSH React UI | 官方交互、状态协调、流式渲染、审批、设置以及 DeepShell UI 扩展 | 直接持有长期 Secret、执行 Shell、决定安全策略 |
| Node/DSH | Agent Loop、Session、模型、Tools、Skills、MCP、Workspace、Sandbox、Approval、持久化 | 窗口生命周期、应用更新、系统级 UI |

模型工具调用的唯一正常路径是：

```text
LLM → DSH → DSH Tool/Capability → OS 或 External Service
```

不得建立以下路径：

```text
LLM → DSH → Rust Command → OS
```

Tauri 可以暴露与产品 UI 相关的窄命令，例如打开原生选择器或在系统浏览器中打开链接；这些命令不是 Agent Tool，也不能被模型直接调用。

### 5.2 启动流程

```text
Tauri 启动
  → 获取单实例锁
  → 解析平台应用数据目录
  → 创建独立 DSH_HOME 与运行目录
  → 以 POC 门禁选定的回环 bind_address 和端口 0 启动固定 Node + DSH
  → 从受控握手读取实际端口、进程作用域启动令牌与绑定事实
  → 完成 Host 健康检查
  → WebView 仅一次导航至含进程作用域 token 的授权 URL
  → DSH 换发 HttpOnly Session Cookie 并清理 URL
  → Client Connection ready
  → 显示主窗口
```

约束：

- Sidecar 的 `bind_address` 只能是 POC 门禁选定并记录的回环 IP 地址，例如 `127.0.0.1` 或 `::1`，不得绑定 `0.0.0.0` 或任何非回环地址。
- WebView 使用单独的 `webview_authority`，可在 `127.0.0.1` 与 `localhost` 中验证后固定；`localhost` 只能作为 URL authority 使用，不能作为“绑定地址”表述。
- 使用端口 `0` 让操作系统分配空闲端口，避免固定端口冲突。
- 启动令牌只允许通过 stdout 专用通道消费，不得写入应用日志、诊断包、浏览历史或崩溃上报。
- 只有在握手中的 PID、`bind_address`、端口、`webview_authority`、随机 nonce（随机数）与 Tauri 启动记录一致时才接受 ready。
- DeepShell 只使用含 token 的 URL 完成首次导航，随后立即转到无 query 的 clean URL；token 随 DSH 进程退出失效。锁定版本官方 Host 没有承诺 token 单次兑换，因此不得把“重复兑换必然被拒绝”作为架构保证。
- Host、Origin 与 Cookie 组合必须与固定的 `webview_authority` 和实际端口一致；错 Origin、错端口、错 Cookie 或跨实例 token 必须拒绝。
- 主窗口在认证、官方 Client Connection 和初始 Session/Workspace/Settings 状态同步完成前保持隐藏或显示无权限的启动页。
- 启动超时必须呈现可操作错误，并提供“重试”和“打开本地诊断日志”，不能无限等待。

### 5.3 UI 与 DSH 通信

V1 基线采用同源通信：DSH Host 托管官方 Web UI 及 DeepShell Client/UI Plugins，WebView 加载 POC 门禁选定的 `http://<webview-authority>:<dynamic-port>`；DSH Host 绑定的是独立记录的回环 `bind_address`。UI 直接使用 DSH 的 HTTP Remote 与 WebSocket stream，不经 Rust 转发业务数据。

```text
Official DSH Web UI
  + DeepShell Client/UI Plugins
  ├── HTTP POST：命令与查询
  └── WebSocket：事件流、Session follow、Cancellation 状态
          │
          ▼
       DSH Host
```

选择这一方案的原因：

- 保留 DSH 已有的请求关联、流恢复、认证、Host/Origin 检查和 Session 事件语义；
- 避免在 Rust 中重新实现 RPC、WebSocket、Cancellation 和流式状态协调；
- 避免 Tauri 自定义协议页面跨域访问 DSH 时破坏 DSH 的严格同源 Cookie 与 Origin 约束。

安全要求：

- DSH Host 必须校验 Host、Origin、Cookie 和浏览器 Session；所有 API 与 Stream 默认拒绝匿名访问。
- hostile local origin（另一个本地回环 Origin）不能调用 HTTP API、WebSocket stream 或高权限 Tauri Command，也不能产生 Session、Run 或 Tool 副作用。
- WebView 禁止导航到非 DSH 回环源；外部链接只能交给系统浏览器。
- 配置严格 CSP（Content Security Policy，内容安全策略）；默认 `connect-src 'self'`，不允许任意远程脚本。
- Assistant 消息、富文本、Tool Output、网页摘要和文档预览必须经过内容清洗，禁止执行其中的 HTML/JavaScript、SVG 事件属性或 `javascript:` URL。
- Tauri 对远程源开放的 Capability 必须绑定主窗口 label，并只包含最小命令集合。
- 如果动态回环源无法被 Tauri Capability 安全、精确地约束，POC 必须改用受控的本地桥接方案；不得通过扩大到任意远程 URL 解决。

### 5.4 退出、崩溃与重启

正常退出顺序：

1. UI 停止接收新 Run，并提示仍在执行的任务。
2. 请求 DSH 优雅停止，等待当前日志落盘和子进程清理。
3. 超时后由 Tauri 终止 Sidecar 进程树。
4. 释放运行目录和单实例锁。

异常策略：

- Sidecar 崩溃时，UI 进入只读断线态，不把未确认的 Tool Call 标记为成功。
- 自动重启采用有限退避；同一次应用运行中连续失败达到阈值后停止重试并显示诊断入口。
- 已持久化 Session 可以恢复；崩溃时处于执行中的 Tool Call 默认标为 `interrupted/unknown`，不得自动重放破坏性操作。
- 重启恢复依赖 DSH 的 durable event log（持久事件日志），不能依赖 WebView 内存状态。

## 6. 组件设计

### 6.1 Tauri Desktop Shell

Tauri 负责：

- 主窗口、辅助窗口、托盘、菜单与快捷键；
- 单实例和 Deep Link；
- Sidecar 启动、握手、健康检查、停止和崩溃监管；
- Auto Update、签名校验与版本切换；
- OS Notification；
- 必要的 File/Directory Picker 与 Open With；
- 平台应用数据目录解析；
- 必要的系统级原生能力桥接，但不承接 Agent 业务语义。

Tauri Command 设计规则：

- 每个命令必须是窄接口，输入使用显式结构和长度限制；
- 文件路径使用 canonical path（规范化路径）并验证用途；
- 不提供 `execute_shell`、`read_any_file`、`write_any_file` 一类通用高权限命令；
- Capability 按窗口和平台拆分，默认拒绝；
- Rust 错误转换为稳定错误码，敏感内部信息只进入脱敏日志。

### 6.2 Official DSH Web UI

V1 直接复用 DSH 官方 Web UI 已有的：

- Chat、Trajectory（运行轨迹）和 Tool Call 展示；
- Session 创建、恢复、搜索、分页和历史；
- Prompt、Attachments 和 File References；
- Streaming、Cancellation、队列与断线恢复；
- Workspace、Models、Skills、MCP、Credentials 和 Settings；
- Approval、Ask User 和 Permission Preset 交互；
- 官方 Client Model、Remote 通信和状态协调。

DeepShell 不建立 Svelte Web App、自建 Chat/Session/Settings UI 或自建 Client Adapter。Session、Job、Workspace、Approval 和 Tool Result 的权威状态仍在 DSH Host，官方 Client Model 维护可重建的前端投影。

### 6.3 DeepShell Client/UI Plugins

DeepShell 的差异化 UI 使用 DSH 官方 TypeScript + React 插件体系实现，包括：

- 产品名称、Logo、tagline 和视觉品牌；
- General、Coding、Work 的入口、选择和当前状态；
- Coding 场景的 Repository、Git、Tests 和 Terminal 视图；
- Work 场景的 Documents、Sources、Knowledge 和 Connectors 视图；
- First-party Documents Plugin 的摘要、结构、引用和预览；
- DeepShell 特有的设置项、Overlay、Conversation View 或 Details View。

扩展优先级为：

```text
Level 1：通过公开 Slot 添加独立 Client/UI Plugin
Level 2：通过 Profile 或 Bundle Patch 替换特定官方 UI Plugin
Level 3：确有必要时替换 ui-layout 或 root composition
```

约束：

- 不 fork 或复制官方 Web UI 源码；
- 不修改 `node_modules`，不 monkey patch DOM，不依赖脆弱 CSS selector；
- 不导入 DSH 私有路径或未声明为公开契约的 React 组件；
- 即使达到 Level 3，也只替换必要的组合层，不重写 Session、Workspace、Streaming、Approval 等基础能力；
- 每个 First-party Client/UI Plugin 都建立固定 DSH 版本的加载、Slot、通信与升级回归测试。

### 6.4 DSH Host / Agent Runtime

DSH 负责：

- Agent Loop 与模型 Provider；
- Session、事件日志、查询和恢复；
- Tool 注册、选择、调用、超时和取消；
- Workspace、Filesystem、Shell 与 Git；
- Skills 与 Agent Preset；
- MCP Client；
- Web Search/Fetch；
- Attachments 和 File References；
- Sandbox、Approval、Interaction 与 Permission Preset；
- Credential Reference 和 Model Catalog。

DeepShell Agent 不建立平行 Runtime。需要补充产品能力时，优先顺序是：

1. 组合现有 DSH Plugin；
2. 编写遵守 DSH capability seam（能力接口）的 First-party Plugin；
3. 通过 MCP 接入外部服务；
4. 只有桌面原生能力才进入 Tauri。

### 6.5 Agent Mode 与 DSH Preset

概念边界：

- **Application Profile：** DSH Host 启动时加载的应用级插件与配置组合。V1 目标只有 `desktop`；`v0.0.1` POC 为降低上游偏离，直接复用官方 `web` Profile，并用 `deepshell-poc` Bundle Patch 叠加桌面集成。
- **Agent Mode：** 用户看到的工作模式，映射为 Session 级 DSH Agent Preset；Preset 决定 Instructions、Skills、Tools 和运行配置，DeepShell React Plugin 负责入口与展示。

V1 模式：

| Mode | 默认目标 | 默认工具组 |
|---|---|---|
| General | 通用问答、本地任务与轻量研究 | 基础文件引用、Web、按需 Skills |
| Coding | 代码理解、编辑、测试与 Git 工作流 | Workspace FS、Shell、Git、Web、GitHub MCP（若启用） |
| Work | 文档、分析和企业工作流 | Documents、Web、已授权的企业 MCP |

模式只能收窄或组合 DSH 权限与工具，不能绕过 Session Approval Policy。切换模式对新 Run 生效；正在执行的 Run 保持启动时快照，避免中途改变工具集合。只有官方 Agent Preset 无法表达的能力，才允许增加最小 Host Plugin；不得建设平行 Mode Runtime 或新的配置 DSL。

MCP Server 可能注册大量工具。V1 按 Preset、Skill 和用户启用状态构建最小工具集合；禁止把所有已安装 MCP 工具无条件暴露给每次模型调用。达到明确规模阈值后再引入 Tool Search/Dynamic Exposure，不在 V1 预建复杂路由器。

### 6.6 First-party Documents Plugin

V1 提供一个统一的 First-party Documents Plugin，而不是按文件格式拆分多个互不关联的 Agent Plugin。插件包含 Host 与 Client/UI 两部分：Host 负责解析、检索和工具，Client/UI 负责摘要、来源定位和预览。

```text
Documents Plugin
├── Host Plugin
│   └── Parser Registry
│       ├── DOCX parser
│       ├── PDF parser
│       ├── PPTX parser
│       └── XLSX parser
└── Client/UI Plugin
    ├── Document summary
    ├── Structure / citations
    └── Page / slide / sheet preview
```

V1 对模型只暴露少量高层工具：

- `read_document`：按页、章节、Sheet 或范围读取；
- `search_document`：在已解析内容中检索并返回来源定位；
- 后续确有需求时再增加写入、批注或导出工具。

每个结果必须携带来源文件、版本指纹和页/Sheet/单元格等定位信息。解析器必须有文件大小、页数、行数、解压倍率、执行时间和内存上限；不可信文档不得加载可执行宏、外部实体或任意外部资源。

文档解析属于 V1 扩展里程碑，在核心 Chat/Session/Approval 闭环稳定后实施，不能阻塞基础桌面壳和 DSH 集成验证。

## 7. 数据与持久化

### 7.1 数据归属

| 数据 | 权威所有者 | 说明 |
|---|---|---|
| Session/Trajectory/Run | DSH | UI 只维护投影 |
| Workspace 文件 | 用户原始目录 | 不默认复制进应用数据目录 |
| Attachment Blob/引用 | DSH | 使用内容寻址和 Session 引用能力 |
| Agent Preset/Skill/MCP 配置 | DSH Profile 与应用配置 | 变更需要校验和版本化 |
| 窗口、主题、桌面偏好 | DeepShell Agent | 不进入 Session 事件日志 |
| API Key/OAuth Token | DSH credentials-local | Settings 只保存 Credential Reference，Secret 位于独立 DSH_HOME |
| 诊断日志 | DeepShell Agent 与 DSH | 本地、轮转、默认脱敏 |

### 7.2 目录布局

实际根目录必须通过 Tauri 平台 Path API 获取，禁止硬编码用户 Home。逻辑布局为：

```text
<Tauri app_data_dir>/             # identifier=com.deepshell.agent，已是应用专用根目录
├── app/                 # 产品设置、窗口状态、迁移版本
├── dsh-home/            # 本应用独立 DSH_HOME
├── logs/                # 轮转和脱敏后的日志
├── runtime/             # PID、握手文件、临时 socket；退出后可清理
└── backups/             # 升级迁移前的有限备份
```

要求：

- 不读取、写入或复用用户已有的全局 DSH CLI Home。
- Workspace 路径只保存引用；删除 Session 不得删除 Workspace。
- App 卸载默认保留用户数据，清除数据必须是独立、明确、可确认的操作。
- 日志与备份设置保留上限和轮转策略，避免无限增长。

### 7.3 凭据

POC 与 V1 使用 DSH 官方 `credentials-local`，保持上游原生行为：

- 启动环境变量优先；
- 受管 Secret 保存在 DeepShell 独立 `$DSH_HOME/.credentials.yaml`；
- Settings 只保存 Credential Reference；
- Web UI 的 Secret 字段只写，保存后只返回脱敏状态；
- 凭据文件和目录使用 DSH 官方的所有者权限限制。

DSH Session、Settings 和前端状态不主动持有 Secret Value。正常凭据配置、模型调用、错误处理和诊断管线不得把 Secret 输出到日志、Tool Result、Crash Dump、Session 导出或诊断包。用户或不可信内容刻意诱导同用户 File/Shell Tool 读取 credentials 后进入 Tool Result/Session，属于下一段所述 POC 残余风险，不作绝对阻断承诺。

必须明确其安全边界：本地文件权限可以阻止其他 OS 用户直接读取，但不能阻止同一用户权限下的进程。`workspace-write` 的官方语义是：Workspace 与 DSH 允许临时目录内写入/编辑直接执行；Workspace 外读取不触发 Approval；Workspace 外写入先由 Sandbox 拒绝，模型携带非空 `justification` 请求一次性扩大权限时才触发 Approval；普通 Sandbox Shell 不逐条 Approval。DeepShell 通过最小插件集合、官方 Approval、日志泄漏检查和风险披露降低风险，但不将其描述为强隔离。macOS Keychain、Windows Credential Manager 或 Linux Secret Service Provider 延后，优先等待 DSH 官方能力；确有更高安全等级要求时，再以符合 DSH Credential 公共契约的 Provider 实现。

## 8. 安全架构

### 8.1 安全原则

- **默认拒绝：** 未配置的 Tauri Capability、MCP、网络源和高风险工具不可用。
- **最小暴露：** Mode/Skill 只暴露任务所需工具。
- **用户在环：** 破坏性或越界操作通过 DSH Approval/Interaction，失败时 fail closed（拒绝执行）。
- **单一安全语义：** DSH 是 Agent 工具权限的唯一裁决者；Tauri 不复制一套规则。
- **来源不等于信任：** 模型输出、MCP 返回、网页和本地文档均可能包含恶意指令。
- **可追溯：** 每次 Run、Tool Call、Approval、配置变更和版本升级均有可关联事件或审计记录。

### 8.2 Sandbox 与 Approval

复用 DSH Sandbox、Approval、Permission Preset 和 Interaction。DeepShell Agent 可以提供 First-party Safety Guard，对下列高风险语义追加审批或拒绝：

- 删除 Workspace 根目录或大规模文件树；
- `git reset --hard`、`git clean -fdx` 等不可逆 Git 操作；
- 写入 Workspace 外部敏感目录；
- 将本地敏感内容发送到新启用的外部服务；
- 修改系统启动项、权限或安全配置。

Safety Guard 只能收紧策略，不能放宽 DSH 的拒绝结果，也不能形成第二套通用权限引擎。

Sandbox 保证可能随平台和安装环境变化。UI 必须展示当前会话实际生效的能力，不得用统一的“已沙箱化”文案掩盖平台差异。发布前需要形成 macOS/Windows 的能力矩阵和降级行为。

### 8.3 Plugin 与 MCP

- First-party Plugin 与应用一起锁版本、构建、签名和升级。
- V1 不加载未经审核的任意本地 Node Plugin，不提供 Plugin Marketplace。
- MCP Server 默认禁用；添加时显示来源、Transport、命令/URL、工具清单和所需凭据。
- stdio MCP 的可执行文件和参数必须以结构化配置保存，禁止经 Shell 拼接。
- MCP 工具首次启用和敏感权限变化需要用户确认。
- Plugin/MCP 错误不能导致 DSH Host 整体崩溃；无法隔离时必须在启动前禁用并给出诊断。

### 8.4 WebView 与内容渲染

- Markdown 使用安全渲染器，默认禁用原始 HTML。
- 代码块、SVG、Mermaid、PDF 和 Office 预览按不可信内容处理。
- 禁止页面内任意 iframe、远程脚本和自动下载。
- 外链显示真实域名并经系统浏览器打开。
- 剪贴板、拖放和文件选择都做类型、大小和路径校验。
- 前端依赖和 Sidecar 依赖都纳入 Software Bill of Materials（SBOM，软件物料清单）与漏洞扫描。

## 9. 版本、构建与发布

### 9.1 版本锁定

构建必须锁定：

- Tauri CLI/Crate 与 Plugin 版本；
- Node.js 精确版本和目标平台校验和；
- DSH 精确 npm 版本或 Git commit；
- pnpm lockfile 与所有 First-party Plugin 版本；
- Rust lockfile；
- 每个平台的 native dependency 构建产物。

禁止使用 `latest`、浮动 tag 或运行时自动更新 DSH/Plugin。DSH 的升级是一次完整产品升级，必须通过公开 Plugin/Slot/Preset 契约测试、迁移、打包和端到端测试。

### 9.2 Sidecar 分发

V1 优先采用“平台 Node Runtime + 预构建的生产 DSH 资源树”，而不是把 DSH 强制编译成单一 `pkg` 可执行文件。原因是 DSH 的插件加载、动态资源和可能的 native module 更适合保留标准 Node 运行语义。

构建产物要求：

- 每个 target triple（目标平台架构）独立构建和签名；
- 生产依赖在 CI 中冻结，不在用户机器运行 `npm install`；
- 启动入口、资源路径和 native module 在安装后的只读目录中可解析；
- 运行期数据全部写入平台应用数据目录，不修改应用安装目录；
- macOS notarization（公证）和 Windows code signing（代码签名）覆盖应用与 Sidecar。

如果 POC 证明标准 Node 资源树无法满足签名、体积或更新要求，才评估 SEA/pkg 等单文件方式；任何替换都必须重新验证 DSH Plugin 和 native module。

### 9.3 原子更新与迁移

应用版本、Node、DSH 和 First-party Plugin 是同一个 Compatibility Set（兼容集合），通过 Tauri Updater 原子发布。启动时按以下顺序处理迁移：

1. 读取旧数据版本，不启动 Agent Run。
2. 创建有限、可识别版本的备份。
3. 执行幂等迁移并记录结果。
4. 验证 Session、配置和 Credential Reference 可读。
5. 成功后启动新 Host；失败则停止并提供恢复说明。

自动回滚只能回滚应用二进制；如果数据迁移不可逆，必须在发布前提供向后兼容读取或显式恢复方案。

## 10. 可观测性与隐私

### 10.1 本地日志

Tauri 与 DSH 使用结构化日志，并共享以下关联字段：

- `app_version`
- `dsh_version`
- `session_id`
- `run_id`
- `tool_call_id`
- `sidecar_instance_id`

默认日志记录状态、耗时、错误码和组件，不记录完整 Prompt、模型回复、文件内容、Secret 或 Tool Output。用户主动导出诊断包时，先预览范围并执行脱敏。

### 10.2 健康状态

产品至少区分：

- Desktop ready；
- Sidecar starting/ready/degraded/crashed；
- Client connected/reconnecting/offline；
- Model Provider configured/unavailable；
- MCP enabled/failed；
- Session running/interrupted/settled。

不得用一个全局“在线/离线”状态覆盖这些不同故障域。

### 10.3 遥测

V1 默认不上传对话、文件内容或 Tool Output。若未来加入产品遥测，必须：

- 明确 opt-in（用户主动选择）；
- 公布字段、目的和保留期；
- 对内容数据与运行指标分通道；
- 支持关闭和删除；
- 不把第三方模型/MCP 的数据处理承诺混同为本产品承诺。

## 11. V1 范围

### 11.1 必须交付

| 能力 | 实现归属 |
|---|---|
| Tauri Window/Lifecycle/Single Instance | DeepShell Agent |
| 固定 Node + DSH Sidecar | DeepShell Agent 封装，复用 DSH |
| Official DSH Web UI | 直接复用 DSH |
| Chat/Session/Streaming/History/Cancellation | DSH 官方 Host 与 Web UI |
| DeepShell Client/UI 扩展 | TypeScript + React 的 DSH Plugin |
| Workspace/Filesystem/Shell | DSH |
| Sandbox/Approval/Interaction | DSH |
| Models/Credentials | DSH 官方能力与 credentials-local |
| Skills/Agent Preset | DSH + 自有内容与 React UI Plugin |
| Attachments/File References | DSH |
| Web | DSH Provider |
| MCP 基础配置 | DSH + DeepShell Agent UI |
| General/Coding/Work | Session Preset + UI |
| DOCX/PDF/PPTX/XLSX 读取、检索与 UI | First-party Host + Client/UI Plugin |
| macOS/Windows 打包、签名、升级 | DeepShell Agent |

### 11.2 明确延后

- 自动 Auxiliary Vision Router；
- Computer Use 与 Chrome Control；
- 公共 Plugin Marketplace；
- 第三方任意 Node Plugin 安装；
- 复杂 Profile 继承、版本解析和 Marketplace；
- 自研 Agent/Sandbox/Permission/Attachment/Skill Runtime；
- 自研 Web UI、Svelte 和 Client Adapter；
- 官方 DSH Web UI fork、DOM monkey patch 和私有 React 组件依赖；
- 移动端；
- Linux 正式支持；
- 多机 Session 同步。

基础图片附件支持遵循当前模型的 `inputModalities`：模型支持图片时发送，不支持时提示切换模型。OCR 是独立文档/图片工具，不自动替换用户选择的模型。

## 12. 初始代码结构

下列是 V1 目标逻辑结构，不要求 POC 预建未使用目录。`v0.0.1` 的实物布局复用官方 `web` Profile：第一方 Host/Client 入口合并在 `dsh/bundles/deepshell-poc/`，运行模板在 `runtime/profile-template/`；`deepshell` Preset 由构建脚本从官方 `standard` 只移除 `tool-web` 后派生，不维护手写副本。

```text
deepshell-agent/
├── docs/
│   ├── architecture.md
│   ├── roadmap.md
│   ├── releases/
│   └── adr/
├── src-tauri/
│   ├── capabilities/            # 最小 Tauri 权限
│   └── src/
│       ├── sidecar/             # 启停、握手、健康、进程树清理
│       └── ...
├── runtime/
│   ├── manifest/                # 可提交的 runtime 锁定清单
│   ├── node/                    # 构建期生成/下载，公开仓库忽略
│   └── dsh/                     # 构建期安装，公开仓库忽略
├── dsh/
│   └── bundles/                 # DeepShell Bundle / Profile Patches
└── tests/
    ├── contract/                # DSH 公开 Plugin/Slot/Preset 契约测试
    ├── integration/             # Host/Sidecar 集成测试
    └── e2e/                     # 安装产物端到端测试
```

初期不建立多 package monorepo。只有出现独立发布、明确复用或构建隔离需求时，才拆分 package。

## 13. POC 与架构门禁

POC 交付一个可运行的 macOS arm64 最小纵向切片，内部包含两个验证轨道。POC 只使用 Coding Mode；不把 General/Work、Documents Plugin、MCP、Skills/Attachments 管理或完整产品 UI 纳入范围。

### POC-A：官方 DSH Web UI 与公开扩展契约

目标：证明 DeepShell 可以直接复用官方 DSH Web UI，并在不 fork、不修改 DOM、不依赖私有 React 实现的前提下形成最小产品身份。

必须验证：

- 官方 Web UI 可由 DeepShell Profile/Bundles 正常加载；
- First-party Branding Plugin 可设置产品名、tagline 和独立品牌标识；POC 中它是 `@deepshell-agent/dsh-poc` Integration Plugin 的 Client 部分；
- Branding Plugin 只使用公开 Client/UI Plugin 与 Slot 契约；
- 官方 Chat、Session、Streaming、Tool Call、Approval、Workspace、Models 和 Settings 保持可用；
- Coding Agent Preset 可以被选择并展示当前状态；
- 为后续 DSH 显式升级准备可自动执行的插件加载与兼容性检查；POC 不要求实际执行上游升级。

通过标准：无需 fork 官方 Web UI、修改 DOM 或导入私有组件，即可得到具有 DeepShell 最小品牌身份且核心交互正常的 Web Client。

POC-A 不验证 General/Work UI、Documents UI、MCP/Skills/Attachments 管理界面或布局重构；这些属于 V1。

官方 Web UI 随锁定 DSH 版本自带但未列入 POC 验收的入口可以保持可见；POC 不为它们编写 DeepShell 定制代码或测试。需要外部配置的 MCP Server 和 Web Provider 默认不启用。

### POC-B：Tauri + DSH 同源 Sidecar

目标：证明官方 DSH Web UI 与 Full DSH 可以在 Tauri WebView 中保持认证、通信、生命周期和最小原生权限。

必须验证：

- POC 门禁选定的回环 `bind_address`、`webview_authority`、端口 `0` 动态分配与可信握手；
- 进程作用域启动令牌、Cookie、Host/Origin 组合校验；
- HTTP、WebSocket、刷新、外链拦截和新 WebView 拦截；
- Tauri 远程源 Capability 的精确约束；
- CSP、hostile local origin 拒绝和不可信 Assistant/Tool Output 清洗；
- Sidecar 崩溃、有限重启、退出进程树清理；
- 不要求用户安装 Node/npm/pnpm；
- macOS arm64 应用产物可以在没有系统 Node/npm/pnpm 的环境中运行；
- DSH 官方 `credentials-local` 位于 DeepShell 独立 DSH_HOME，Secret 不进入日志、Session 或诊断输出；
- 使用 DSH 官方 `workspace-write` Permission Preset，不实现自定义权限插件；
- POC 使用 `deepshell` Agent Preset，它由锁定版本官方 `standard` 机械派生且唯一差异为移除 `tool-web`；这不修改 `workspace-write` Permission Preset；
- Workspace 与 DSH 允许临时目录内写入/编辑可直接执行，越界写入先被 Sandbox 拒绝，模型请求一次性扩大权限时触发 Approval；
- 文件读取不受 Workspace 边界限制，普通 Sandbox 内 Shell 不逐次 Approval；
- Workspace 内删除、批量修改和破坏性 Git 操作不做额外语义审批，这些限制作为 POC 已知风险记录；
- Approval 在 UI 断线、超时或 Sidecar 崩溃时 fail closed。

通过标准：安装后首次启动、正常退出和异常恢复稳定；任意非授权本地网页不能调用 DSH API 或高权限 Tauri Command。上传、下载、大消息、多窗口、Auto Update 和数据迁移不属于 POC-B，通过后续 MVP 门禁单独验证。

POC-A 与 POC-B 最终合并为一个集成式可运行 POC，而不是两个互不连接的 Demo。更完整的 macOS/Windows 安全矩阵、MCP 故障隔离、Documents Plugin 和数据迁移属于 V1 门禁。

POC 使用官方目录选择器创建 Workspace，不开发 Tauri File Picker、Workspace 文件树或文件预览。Agent 通过官方文件工具操作 Workspace；文件引用使用锁定版本已有入口，若无入口则在 Prompt 中使用相对路径。

## 14. 测试与验收策略

### 14.1 自动化测试层次

| 层次 | 重点 |
|---|---|
| Unit | Branding Plugin、错误码、Mode/Preset、路径和配置校验 |
| Contract | 锁定 DSH 版本的公开 Plugin、Slot、Preset、RPC 和事件语义 |
| Integration | Tauri Supervisor + Sidecar + DSH + 测试 Provider/MCP |
| E2E | 安装后的首次启动、会话、工具、审批、崩溃恢复、更新 |
| Security | Origin/Auth、CSP、XSS、路径越界、Secret 泄漏、恶意 MCP/文档 |
| Packaging | 每个目标平台的签名、native module、卸载和数据保留 |

### 14.2 V1 架构验收场景

至少覆盖：

1. 新安装，无系统 Node 环境也能启动。
2. 固定端口被占用时仍可启动。
3. 恶意网页不能访问本机 DSH API。
4. UI 刷新或 WebSocket 重连后，Session 状态与 Tool Call 不重复。
5. 执行中的 Shell 被取消后，状态和子进程一致收敛。
6. Sidecar 被强制终止后，UI 不伪报成功，重启可恢复已落盘历史。
7. 破坏性操作在用户拒绝、超时或 UI 断线时不执行。
8. Secret 不出现在前端状态、日志、Session 导出和诊断包中。
9. DSH 升级时契约测试和数据迁移测试通过。
10. 应用更新后 Node/DSH/Plugin 版本仍属于同一兼容集合。

## 15. 实施顺序

1. 建立版本清单、lockfile、目标平台矩阵和最小 CI。
2. 完成 POC-A，冻结官方 Web UI 的公开 Plugin/Slot/Branding 扩展边界。
3. 完成 POC-B，冻结启动握手、同源通信和 Sidecar Supervisor。
4. 合并两个轨道，完成 macOS arm64 集成式 POC 的功能、安全与恢复验收。
5. 实现 General/Coding/Work Agent Preset、模式入口与工具收敛。
6. 加入 Skills、MCP 和企业连接配置。
7. 实现 First-party Documents Host + Client/UI Plugin。
8. 补齐 Updater、Deep Link、系统集成与数据迁移。
9. 完成 macOS/Windows 安装、签名、升级、安全与恢复验收。

## 16. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| DSH 仍处于 Developer Preview | API/包结构破坏性变化 | 精确锁版本、公开扩展契约测试、显式升级 |
| 官方 Slot/Plugin 覆盖范围不足 | 差异化 UI 无法以追加方式实现 | 按最小范围替换指定 UI Plugin 或 composition，禁止 fork/DOM patch |
| Tauri 远程回环页面权限边界复杂 | XSS 或本地恶意源扩大权限 | 同源认证、导航锁定、最小 Capability、POC-B 安全测试 |
| Node/Plugin/native module 跨平台分发 | 安装或签名失败 | 每 target 独立构建、真实安装产物测试、禁止用户机安装依赖 |
| Sandbox 平台差异 | UI 承诺与实际保护不一致 | 能力探测、平台矩阵、明确降级、必要时阻止高风险模式 |
| MCP/文档导致 Prompt Injection | 数据泄漏或错误工具调用 | 不可信内容标记、工具最小化、Approval、外发边界提示 |
| 上游品牌或商标误解 | 用户误认为 DeepSeek 或 DSH 官方产品 | 独立品牌说明、许可证和商标审查，不声称隶属、授权或背书 |
| 文档能力范围过大 | 拖慢核心 V1 | 核心闭环后实施，V1 限定读取/检索和来源定位 |

## 17. 非目标与禁止事项

- 不 fork DSH 形成长期私有分支，除非上游阻塞问题已有独立 ADR 和退出计划。
- 不通过 Rust 转发所有 Agent Tool。
- 不让 DeepShell Client/UI Plugin 成为 Session 权威数据源。
- 不在运行时执行包管理器安装或拉取浮动依赖。
- 不默认加载所有 MCP 工具、Provider 或 Plugin。
- 不把 DSH 本地凭据文件描述为同一用户进程之间的强安全边界。
- 不用静态页面返回 `200` 代替 Sidecar、Client、模型和工具链路的完整健康验证。

## 18. 上游依据

以下链接用于说明本架构所依赖的上游能力；具体实现仍以项目锁定版本的源码和 POC 结果为准：

- [DeepSeek Harness 官方项目与开发者预览说明](https://github.com/deepseek-ai/deepseek-harness)
- [DSH Web Client architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-client.md)
- [DSH Client Connection 与浏览器认证边界](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)
- [DSH HTTP Server](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-server)
- [Tauri：Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)
- [Tauri Capabilities 与 Remote API Access](https://v2.tauri.app/security/capabilities/)

---

本架构在集成式 POC 的两个验证轨道通过后进入冻结状态。在此之前，“官方 Web UI 可通过公开契约形成 DeepShell 最小品牌”“同源 Sidecar 可安全稳定运行”“既定 Workspace、Shell 与 Approval 策略真实生效”都是架构门禁，不应在产品计划中当作已经完成的事实。
