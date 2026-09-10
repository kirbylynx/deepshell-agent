语言：[English](roadmap.md) | 简体中文

# DeepShell Agent Roadmap

> **产品：** DeepShell Agent
>
> **Tagline:** A desktop agent powered by DeepSeek Harness.
>
> **状态：** 功能池、优先级、实现状态与发布规划基线；`v0.0.1` POC 已完成可行性验证，`v0.1.0` MVP 已落地项已标注，选定的 `v0.1.1` 发布硬化项已落地，选定的 `v0.1.2` DSH runtime refresh 项已落地到当前源码基线
>
> **日期：** 2026-09-10

## 1. 文档目的

本文定义 DeepShell Agent 的版本阶段、功能池和优先级。它用于说明“为什么发布一个版本”和“哪些能力更重要”，不提前承诺具体功能从哪个版本开始实现。

公开架构、版本收口与功能状态分别见：

- [`docs/architecture.zh.md`](architecture.zh.md)
- [`docs/releases/v0.0.1.zh.md`](releases/v0.0.1.zh.md)
- [`docs/releases/v0.1.0.zh.md`](releases/v0.1.0.zh.md)
- [`docs/releases/v0.1.1.zh.md`](releases/v0.1.1.zh.md)
- [`docs/releases/v0.1.2.zh.md`](releases/v0.1.2.zh.md)

说明：`docs/plans/` 是本地过程文档目录，用于需求推演、设计草案、实施计划和验收证据整理，默认不随公开源码仓库发布。公开仓库中的 Roadmap 只记录功能池、优先级和实现状态。

## 2. 版本阶段

| 阶段 | 起始版本 | 目的 | 完成含义 |
|---|---|---|---|
| POC | `v0.0.1` | 验证技术架构和关键集成是否可行 | 对关键假设给出可复现的通过/不通过结论，不代表产品可用 |
| MVP | `v0.1.0` | 形成最小可用版本 | 用户可以完成核心任务闭环，并具备基本稳定性、安全性和可恢复性 |

当前 POC 收口结论：`v0.0.1` 的 POC 状态为 `Pass`，公开结论见 `docs/releases/v0.0.1.md`。该结论只表示架构假设已被验证，可以进入从 `v0.1.0` 开始的 MVP 范围切分；不代表已经达到产品发布标准。

当前 MVP 范围结论：`v0.1.0` 确认为跨平台最小可用版本，目标覆盖 macOS arm64 与 Windows x64、Coding Mode 与 Work Mode、官方 DSH Web UI 复用、DeepSeek 官方 API、OpenAI-compatible API、Responses API、官方凭据/权限方案，以及 DeepSeek Web Search 与公共 HTTP(S) Web Fetch。具体过程方案保留在本地 `docs/plans/v0.1.0-mvp/`；本文的功能池优先级仍只表达全局相对重要性，不自动替代版本需求文档。

规则：

- 第一个 POC 版本固定为 `v0.0.1`。
- 如果需要继续进行可行性验证，后续使用 `v0.0.2`、`v0.0.3` 等 `v0.0.x` 版本。
- 第一个达到最小可用标准的版本固定为 `v0.1.0`。
- 本文不为任何单项功能指定目标版本、开始版本、发布日期或完成日期。
- 功能进入具体版本前，必须单独完成范围确认、依赖分析和验收标准定义。
- POC/MVP 的具体过程文档保留在本地 `docs/plans/`；Roadmap 中的优先级不自动改变已确认的版本范围。

## 3. 优先级定义

| 优先级 | 含义 | 排序原则 |
|---|---|---|
| P0 | 架构或核心链路阻塞项 | 不成立就无法证明产品路线可行，或无法形成基本运行闭环 |
| P1 | 核心产品能力 | 对最小可用性、稳定性、安全性或主要用户价值非常重要 |
| P2 | 重要增强能力 | 能显著改善效率、体验或适用范围，但不阻塞基本产品闭环 |
| P3 | 远期或探索能力 | 依赖真实使用反馈、生态成熟度或额外安全设计后再评估 |

优先级只表达相对重要性，不等同于版本归属。相同优先级的功能也不代表同时开发。

状态列记录当前实现事实和已确认的活跃版本规划事实：

- `已实现（v0.1.0）` 表示该功能已在 `v0.1.0` MVP 中落地并纳入当前验证基线。
- `已实现（v0.1.1）` 表示该功能已在 `v0.1.1` 发布硬化基线中落地，并纳入当前验证范围。
- `已实现（v0.1.2）` 表示该功能已在 `v0.1.2` DSH runtime refresh 基线中落地，并纳入当前验证范围。
- `待实现（v0.1.1）` 表示该功能已进入当前 `v0.1.1` 规划/开发分支，但尚未作为已实现功能落地。
- `待实现（v0.1.2）` 表示该功能已进入当前 `v0.1.2` DSH runtime refresh 分支，但尚未作为已实现功能落地。
- `未开始` 表示该 Roadmap 功能项尚未作为完整功能落地；如果某个组合项只完成了一部分，也仍按未完整实现处理。
- `待实现` 不是实现声明，也不替代需求、设计、实施计划或版本收口文档。

## 4. 功能池

### 4.1 Desktop Shell 与运行时

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| DESK-001 | Tauri 2 Desktop Shell | 提供原生桌面应用宿主；平台发布验收见 Release 类功能 | P0 | 已实现（v0.1.0） |
| DESK-002 | 单主窗口 | 承载官方 DSH Web UI | P0 | 已实现（v0.1.0） |
| DESK-003 | 单实例 | 第二次启动唤起已有实例，避免重复 Sidecar | P0 | 已实现（v0.1.0） |
| DESK-004 | Bundled Node.js | 最终用户无须安装 Node/npm/pnpm | P0 | 已实现（v0.1.0） |
| DESK-005 | Full Pinned DSH | 随应用分发精确锁定的官方 DSH npm 版本 | P0 | 已实现（v0.1.0） |
| DESK-006 | Sidecar 启动握手 | 管理 PID、动态端口、nonce、ready 与启动超时 | P0 | 已实现（v0.1.0） |
| DESK-007 | Sidecar 健康检查 | 区分 starting、ready、degraded 和 crashed | P0 | 已实现（v0.1.0） |
| DESK-008 | Sidecar 优雅退出 | 落盘后退出，并在超时后清理进程树 | P0 | 已实现（v0.1.0） |
| DESK-009 | Sidecar 崩溃恢复 | 有限自动重启、interrupted 状态和手动恢复入口 | P0 | 已实现（v0.1.0） |
| DESK-010 | 独立 DSH_HOME | 不污染或复用用户已有 DSH CLI 环境 | P0 | 已实现（v0.1.0） |
| DESK-011 | 动态回环端口 | 仅绑定 loopback，避免固定端口冲突 | P0 | 已实现（v0.1.0） |
| DESK-012 | 基础菜单 | About、Quit 和版本信息 | P0 | 已实现（v0.1.0） |
| DESK-013 | 外部链接处理 | 在系统浏览器打开非本地链接 | P0 | 已实现（v0.1.0） |
| DESK-014 | Tray | 托盘状态与常用操作 | P2 | 未开始 |
| DESK-015 | Native Menu 与快捷键 | 提供完整桌面菜单和全局/应用快捷键 | P2 | 未开始 |
| DESK-016 | OS Notification | 长任务完成、失败或需要用户处理时通知 | P2 | 未开始 |
| DESK-017 | Deep Link | 通过协议链接打开应用、Workspace 或 Session | P2 | 未开始 |
| DESK-018 | Auto Launch | 登录系统后按用户配置启动 | P3 | 未开始 |
| DESK-019 | Open With | 从系统文件关联进入 DeepShell | P2 | 未开始 |
| DESK-020 | Reveal in Folder | 从应用定位到系统文件管理器 | P2 | 未开始 |
| DESK-021 | 原生 File/Directory Picker | 在官方 Picker 不足时提供最小 Tauri 桥接 | P2 | 未开始 |
| DESK-022 | 多窗口 | 支持独立 Session、设置或辅助窗口 | P3 | 未开始 |

### 4.2 官方 Web UI 与产品界面

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| UI-001 | Official DSH Web UI | 直接复用官方 React Web Client | P0 | 已实现（v0.1.0） |
| UI-002 | DeepShell Branding Plugin | 产品名、tagline、Logo 和基础品牌入口 | P0 | 已实现（v0.1.0） |
| UI-003 | 正式视觉品牌 | 正式 Logo、图标、色彩、主题和应用素材 | P1 | 已实现（v0.1.0） |
| UI-004 | Agent Mode 入口 | 通过官方 Agent Preset UI 和 DeepShell Mode header 指示器显示并切换 General、Coding、Work | P1 | 已实现（v0.1.1） |
| UI-005 | Coding Repository 视图 | 展示仓库、分支、状态和相关操作 | P1 | 未开始 |
| UI-006 | Git 视图 | 展示 Diff、变更、提交与工作树状态 | P1 | 未开始 |
| UI-007 | Tests 视图 | 展示测试执行、进度和失败详情 | P1 | 未开始 |
| UI-008 | Terminal 视图 | 展示受控终端和命令运行状态 | P1 | 未开始 |
| UI-009 | Work Documents 视图 | 展示文档、摘要、结构和来源 | P1 | 未开始 |
| UI-010 | Sources/Knowledge 视图 | 展示来源、知识内容和引用关系 | P2 | 未开始 |
| UI-011 | Connectors 视图 | 展示 MCP/SaaS 连接和状态 | P1 | 未开始 |
| UI-012 | DeepShell Settings | 扩展产品专属设置项 | P1 | 未开始 |
| UI-013 | Overlay | 提供适合短交互的浮层能力 | P2 | 未开始 |
| UI-014 | Conversation View 扩展 | 增加 DeepShell 专属会话呈现 | P2 | 未开始 |
| UI-015 | Details View | 展示运行、工具或业务对象详情 | P2 | 未开始 |
| UI-016 | Layout Composition 替换 | 官方 Slot 不足时最小替换布局组合 | P3 | 未开始 |
| UI-017 | 国际化 | 复用官方 Locale，并覆盖 DeepShell 自有文案 | P1 | 未开始 |
| UI-018 | 可访问性 | 键盘操作、焦点、状态提示和辅助技术支持 | P1 | 未开始 |

### 4.3 DSH Profile、Bundle 与扩展体系

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| EXT-001 | DeepShell Desktop Profile | 组合官方 Bundle、DeepShell Plugin 和配置 | P0 | 已实现（v0.1.0） |
| EXT-002 | DeepShell Bundle/Patch | 通过公开配置层增加或替换能力 | P0 | 已实现（v0.1.0） |
| EXT-003 | Client/UI Plugin 基础 | 使用 TypeScript + React 和公开 Slot | P0 | 已实现（v0.1.0） |
| EXT-004 | Host Plugin 基础 | 使用公开 Service、Tool、Provider 和生命周期契约 | P1 | 已实现（v0.1.0） |
| EXT-005 | Plugin 兼容性测试 | 固定 DSH 版本的加载、Slot 和通信回归 | P0 | 已实现（v0.1.0） |
| EXT-006 | Plugin Inventory | 显示当前加载的官方与 First-party Plugin | P2 | 未开始 |
| EXT-007 | 第三方本地 Plugin 安装 | 在明确安全模型下安装外部 Plugin | P3 | 未开始 |
| EXT-008 | Plugin Marketplace | 发现、安装、评分和更新 Plugin | P3 | 未开始 |
| EXT-009 | Plugin 签名与来源验证 | 验证发布者、完整性和版本来源 | P3 | 未开始 |
| EXT-010 | Agent Mode Marketplace | 分发面向用户的模式组合 | P3 | 未开始 |
| EXT-011 | 复杂 Profile/Mode 继承 | 版本、依赖、继承和冲突解析 | P3 | 未开始 |
| EXT-012 | DSH 0.1.5 Plugin API 兼容 | 保持 DeepShell First-party Client/UI 和 Bundle 集成兼容上游 DSH 0.1.5 公开扩展契约 | P0 | 已实现（v0.1.2） |

### 4.4 模型与凭据

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| MODEL-001 | DeepSeek 官方 Provider | 配置 API Key 并完成真实模型调用 | P0 | 已实现（v0.1.0） |
| MODEL-002 | 官方 Models Settings | 复用 Provider、模型和凭据设置界面 | P0 | 已实现（v0.1.0） |
| MODEL-003 | Model Catalog | 使用 DSH 官方模型目录 | P1 | 已实现（v0.1.0） |
| MODEL-004 | 模型能力提示 | 根据 `inputModalities` 展示和校验输入能力 | P1 | 未开始 |
| MODEL-005 | 多 Provider | 接入其他官方支持的模型 Provider | P1 | 已实现（v0.1.0） |
| MODEL-006 | Custom Provider | 配置 OpenAI-compatible 等自定义 endpoint | P2 | 已实现（v0.1.0） |
| MODEL-007 | 模型选择 | 按 Session 选择模型并保存事实 | P1 | 已实现（v0.1.0） |
| MODEL-008 | Provider 可用性状态 | 区分未配置、认证失败和服务不可用 | P1 | 已实现（v0.1.0） |
| MODEL-009 | DeepSeek-V4.1-Flash 兼容 | 接入并验证上游 DeepSeek adapter/catalog 对 `DeepSeek-V41-Flash` / `deepseek-flash` 的能力和默认模型行为 | P0 | 已实现（v0.1.2） |
| CRED-001 | DSH credentials-local | Credential Reference 与只写 Secret 配置 | P0 | 已实现（v0.1.0） |
| CRED-002 | Secret 脱敏 | Secret 不进入 Session、日志或诊断包 | P0 | 已实现（v0.1.0） |
| CRED-003 | macOS Keychain Provider | 使用符合 DSH 契约的系统凭据 Provider | P2 | 未开始 |
| CRED-004 | Windows Credential Manager | Windows 系统凭据 Provider | P2 | 未开始 |
| CRED-005 | Linux Secret Service | Linux 系统凭据 Provider | P3 | 未开始 |
| CRED-006 | OAuth/原生认证 | 支持 Provider 或 SaaS 的授权流程 | P2 | 未开始 |

### 4.5 Agent Mode 与工作流

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| MODE-001 | Coding Mode | 面向代码理解、编辑、测试和 Git 工作流 | P0 | 已实现（v0.1.0） |
| MODE-002 | General Mode | 面向通用问答、本地任务和轻量研究 | P1 | 未开始 |
| MODE-003 | Work Mode | 面向文档、分析和企业工作流 | P1 | 已实现（v0.1.0） |
| MODE-004 | Coding Preset 映射 | Coding Mode 映射到 Session 级官方 Preset | P0 | 已实现（v0.1.0） |
| MODE-005 | Work Preset 映射 | Work Mode 映射到 Session 级官方 Preset | P1 | 已实现（v0.1.0） |
| MODE-006 | Instructions 配置 | 为不同 Mode 组合指令 | P1 | 未开始 |
| MODE-007 | Skills 配置 | 为不同 Mode 组合默认 Skills | P1 | 未开始 |
| MODE-008 | Tool Groups | 为不同 Mode 收敛工具集合 | P1 | 未开始 |
| MODE-009 | Context Strategy | 为不同 Mode 选择上下文策略 | P2 | 未开始 |
| MODE-010 | Mode 切换快照 | 新 Run 生效，运行中的 Run 保持启动快照 | P1 | 已实现（v0.1.0） |
| MODE-011 | Research/Data/Recruiting/Engineering Mode | 基于真实需求扩展工作模式 | P2 | 未开始 |
| MODE-012 | General Preset 映射 | General Mode 映射到 Session 级官方 Preset | P1 | 已实现（v0.1.1） |

### 4.6 Session、Conversation 与运行状态

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| SESSION-001 | 创建 Session | 在 Workspace 中创建对话 | P0 | 已实现（v0.1.0） |
| SESSION-002 | Session 列表与切换 | 浏览多个 Workspace 和 Session | P0 | 已实现（v0.1.0） |
| SESSION-003 | History | 持久化并恢复消息和工具事件 | P0 | 已实现（v0.1.0） |
| SESSION-004 | Streaming | 增量呈现 Assistant 响应 | P0 | 已实现（v0.1.0） |
| SESSION-005 | Cancellation | 取消 Run 并正确收敛状态 | P0 | 已实现（v0.1.0） |
| SESSION-006 | Tool Call 展示 | 展示参数、状态、结果与错误 | P0 | 已实现（v0.1.0） |
| SESSION-007 | Trajectory | 查看完整 Agent 运行轨迹 | P1 | 未开始 |
| SESSION-008 | Approval 交互 | 展示授权请求并记录结果 | P0 | 已实现（v0.1.0） |
| SESSION-009 | Ask User | Agent 向用户提出结构化问题 | P1 | 未开始 |
| SESSION-010 | Queue/Job 状态 | 展示排队、运行、完成和失败 | P1 | 已实现（v0.1.0） |
| SESSION-011 | 断线重连 | 恢复事件流且不重复 durable 消息 | P0 | 已实现（v0.1.0） |
| SESSION-012 | 崩溃恢复 | 恢复已落盘历史并标记 interrupted | P0 | 已实现（v0.1.0） |
| SESSION-013 | Session 搜索 | 按标题或内容查找 Session | P1 | 未开始 |
| SESSION-014 | Pagination | 大量历史的分页加载 | P1 | 未开始 |
| SESSION-015 | 标题生成与编辑 | 自动生成并允许修改标题 | P2 | 未开始 |
| SESSION-016 | Archive/Unarchive | 管理不活跃 Session | P2 | 未开始 |
| SESSION-017 | Fork | 从既有历史创建分支 Session | P2 | 未开始 |
| SESSION-018 | Delete | 删除 Session 数据并提供明确确认 | P2 | 未开始 |
| SESSION-019 | Session 导出 | 导出可审计的会话与运行记录 | P2 | 未开始 |
| SESSION-020 | 多机 Session 同步 | 在设备之间同步和恢复 Session | P3 | 未开始 |
| SESSION-021 | DSH Session format V3 迁移保护 | 通过有限升级前 Session 备份、不可降级提示和失败安全信息保护 DSH runtime refresh | P0 | 已实现（v0.1.2） |
| SESSION-022 | 真实旧 Session 升级验收 | tag/release 发布前，手工验证代表性的 `v0.1.1` Session 可在 `v0.1.2` 下打开或正确迁移 | P0 | 未开始 |

### 4.7 Workspace、文件、Shell 与 Git

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| WORK-001 | Workspace 选择 | 复用官方 native/browse directory picker | P0 | 已实现（v0.1.0） |
| WORK-002 | Workspace 注册与切换 | 管理多个 Workspace 引用 | P0 | 已实现（v0.1.0） |
| WORK-003 | 文件读取 | 通过 DSH 官方 Filesystem 读取内容 | P0 | 已实现（v0.1.0） |
| WORK-004 | 文件写入与编辑 | 通过 DSH 官方工具修改 Workspace | P0 | 已实现（v0.1.0） |
| WORK-005 | 文件搜索 | 使用官方 glob/grep 能力查找文件和内容 | P1 | 已实现（v0.1.0） |
| WORK-006 | File References | 在 Prompt 中引用 Workspace 文件 | P1 | 已实现（v0.1.0） |
| WORK-007 | Workspace 文件树 | 在侧边栏浏览目录和文件 | P1 | 未开始 |
| WORK-008 | 文本文件预览 | 在 UI 中安全预览文件 | P1 | 未开始 |
| WORK-009 | Repository 面板 | 展示仓库状态和结构 | P1 | 未开始 |
| WORK-010 | Shell | 使用 DSH 官方 Bash/Terminal 工具 | P0 | 已实现（v0.1.0） |
| WORK-011 | Git | 支持状态、Diff、提交和分支工作流 | P1 | 已实现（v0.1.0） |
| WORK-012 | Test Runner | 运行并展示测试结果 | P1 | 已实现（v0.1.0） |
| WORK-013 | Terminal Session | 提供可持续、可观察的终端会话 | P1 | 未开始 |
| WORK-014 | Attachments | 使用 DSH 内容寻址和 Session 引用 | P1 | 未开始 |
| WORK-015 | Workspace 多根目录 | 一个工作上下文组合多个根目录 | P3 | 未开始 |

### 4.8 Sandbox、Approval 与安全

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| SAFE-001 | 官方 workspace-write Preset | 使用官方 Sandbox 与 Approval 语义 | P0 | 已实现（v0.1.0） |
| SAFE-002 | Permission Preset UI | 显示并切换实际生效权限 | P1 | 已实现（v0.1.0） |
| SAFE-003 | Sandbox escalation | 越界操作按官方流程请求单次授权 | P0 | 已实现（v0.1.0） |
| SAFE-004 | Fail-closed Approval | 无回答、断线、超时或错误时拒绝 | P0 | 已实现（v0.1.0） |
| SAFE-005 | Tauri 最小 Capability | 按窗口、平台和命令限制权限 | P0 | 已实现（v0.1.0） |
| SAFE-006 | Loopback Host/Origin 认证 | 防止未授权本地页面访问 DSH | P0 | 已实现（v0.1.0） |
| SAFE-007 | WebView 导航限制 | 禁止任意远程导航和窗口 | P0 | 已实现（v0.1.0） |
| SAFE-008 | CSP | 禁止远程脚本并限制连接来源 | P0 | 已实现（v0.1.0） |
| SAFE-009 | 不可信内容清洗 | 安全渲染 Markdown、网页、文档和 Tool Output | P1 | 未开始 |
| SAFE-010 | Safety Guard | 对删除、批量覆盖和破坏性 Git 追加控制 | P2 | 未开始 |
| SAFE-011 | Workspace 外读取控制 | 在需要更强数据边界时增加策略 | P2 | 未开始 |
| SAFE-012 | 平台 Sandbox 能力矩阵 | 展示 macOS/Windows/Linux 实际保护和降级 | P1 | 未开始 |
| SAFE-013 | MCP 权限与来源展示 | 显示命令、URL、工具、凭据和风险 | P1 | 未开始 |
| SAFE-014 | Plugin 安全策略 | 限制高权限扩展的来源和加载 | P1 | 未开始 |
| SAFE-015 | SBOM | 生成软件物料清单 | P1 | 已实现（v0.1.1） |
| SAFE-016 | 漏洞扫描 | 扫描 Rust、Node 与打包依赖 | P1 | 已实现（v0.1.1） |
| SAFE-017 | 审计追踪 | 关联 Run、Tool Call、Approval 和配置变化 | P1 | 未开始 |
| SAFE-018 | Prompt Injection 防护 | 标记不可信来源并控制工具与外发边界 | P1 | 未开始 |

### 4.9 Skills

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| SKILL-001 | DSH Skills Runtime | 直接复用官方 Skill 能力 | P1 | 未开始 |
| SKILL-002 | Bundled Skills | 随应用提供 DeepShell First-party Skills | P1 | 未开始 |
| SKILL-003 | Skills UI | 查看、启用和管理 Skills | P1 | 未开始 |
| SKILL-004 | PR Review Skill | 代码审查工作流 | P2 | 未开始 |
| SKILL-005 | Contract Review Skill | 合同审查工作流 | P2 | 未开始 |
| SKILL-006 | Research Skill | 研究与证据整理工作流 | P2 | 未开始 |
| SKILL-007 | Excel Analysis Skill | 表格分析工作流 | P2 | 未开始 |
| SKILL-008 | Recruiting Skill | 招聘与候选人处理工作流 | P2 | 未开始 |
| SKILL-009 | Tender Analysis Skill | 招投标文档分析工作流 | P2 | 未开始 |

### 4.10 Documents Plugin

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| DOC-001 | 统一 Documents Plugin | 一个 First-party Host + Client/UI Plugin | P1 | 未开始 |
| DOC-002 | DOCX 结构化解析 | 提取段落、表格、样式和来源定位 | P1 | 未开始 |
| DOC-003 | PDF 解析 | 提取 born-digital PDF 文本与布局 | P1 | 未开始 |
| DOC-004 | PPTX 结构化解析 | 提取幻灯片、文本和结构 | P1 | 未开始 |
| DOC-005 | XLSX 结构化解析 | 提取 Sheet、区域、表格和单元格 | P1 | 未开始 |
| DOC-006 | `read_document` | 按页、章节、Sheet 或范围读取 | P1 | 未开始 |
| DOC-007 | `search_document` | 检索内容并返回来源定位 | P1 | 未开始 |
| DOC-008 | 文档来源与版本指纹 | 保留文件、版本、页/Sheet/单元格来源 | P1 | 未开始 |
| DOC-009 | Document Summary UI | 展示摘要和基础元数据 | P1 | 未开始 |
| DOC-010 | Structure/Citations UI | 展示结构和引用定位 | P1 | 未开始 |
| DOC-011 | Page/Slide/Sheet Preview | 安全文档预览 | P1 | 未开始 |
| DOC-012 | `render_document` | 将文档内容渲染为可检查产物 | P2 | 未开始 |
| DOC-013 | `extract_tables` | 统一提取表格 | P2 | 未开始 |
| DOC-014 | OCR | 按需处理扫描件 | P2 | 未开始 |
| DOC-015 | 文档写入与批注 | 修改、批注或生成文档 | P2 | 未开始 |
| DOC-016 | 文档导出 | 导出处理结果和派生产物 | P2 | 未开始 |
| DOC-017 | 解析资源限制 | 文件大小、页数、解压倍率、时间和内存限制 | P1 | 未开始 |
| DOC-018 | 恶意文档防护 | 禁止宏、外部实体和非授权外部资源 | P1 | 未开始 |

### 4.11 MCP、SaaS 与 Web

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| INT-001 | DSH MCP Client | 复用官方 MCP 能力 | P1 | 未开始 |
| INT-002 | MCP 配置 UI | 添加、启用、禁用并诊断 Server | P1 | 未开始 |
| INT-003 | MCP Tool 收敛 | 只向模型暴露任务所需工具 | P1 | 未开始 |
| INT-004 | GitHub MCP | 仓库、Issue、PR 等能力 | P1 | 未开始 |
| INT-005 | Notion MCP | 页面和知识内容连接 | P2 | 未开始 |
| INT-006 | Slack MCP | 消息与协作连接 | P2 | 未开始 |
| INT-007 | Database MCP | 数据库查询和受控操作 | P2 | 未开始 |
| INT-008 | Office/SaaS MCP | 其他企业工作服务连接 | P2 | 未开始 |
| INT-009 | Web Search | 使用 DSH Web Provider 搜索 | P1 | 已实现（v0.1.0） |
| INT-010 | Web Fetch | 获取网页内容并保留来源 | P1 | 已实现（v0.1.0） |
| INT-011 | Web Provider 配置 | 管理搜索或抓取服务 | P1 | 已实现（v0.1.0） |
| INT-012 | 专用企业 Host Plugin | MCP 不满足性能、权限或审计时使用 | P2 | 未开始 |
| INT-013 | Tool Search | 工具规模扩大后的动态发现 | P2 | 未开始 |
| INT-014 | Dynamic Exposure | 按 Mode/Skill/任务动态暴露工具 | P2 | 未开始 |

### 4.12 图片、多模态与自动操作

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| MEDIA-001 | 图片附件 | 复用 DSH Attachments | P1 | 未开始 |
| MEDIA-002 | 原生多模态 | 模型支持图片时由 DSH 原生路径发送 | P1 | 未开始 |
| MEDIA-003 | 能力不匹配提示 | 不支持图片时提示切换模型 | P1 | 未开始 |
| MEDIA-004 | Auxiliary Vision Router | 自动调用辅助视觉模型并回传结果 | P3 | 未开始 |
| MEDIA-005 | Computer Use | 操作桌面应用和系统 UI | P3 | 未开始 |
| MEDIA-006 | Chrome Control | 控制浏览器并执行网页任务 | P3 | 未开始 |

### 4.13 数据、可观测性与隐私

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| OPS-001 | 平台数据目录 | 区分 app、dsh-home、logs、runtime、backups | P0 | 已实现（v0.1.0） |
| OPS-002 | Session 持久化 | 以 DSH durable event log 为权威事实 | P0 | 已实现（v0.1.0） |
| OPS-003 | Attachment 持久化 | 内容寻址、校验和 Session 引用 | P1 | 未开始 |
| OPS-004 | 结构化日志 | 关联应用、DSH、Session、Run 和 Tool Call | P0 | 已实现（v0.1.0） |
| OPS-005 | 日志脱敏与轮转 | 控制 Secret、内容和磁盘增长 | P0 | 已实现（v0.1.0） |
| OPS-006 | Runtime 状态 | 区分 Desktop、Sidecar、Client、Provider 和 MCP 状态 | P0 | 已实现（v0.1.0） |
| OPS-007 | 诊断包 | 用户可预览、脱敏并导出诊断信息 | P1 | 已实现（v0.1.1） |
| OPS-008 | 性能观测 | 启动、内存、体积和运行耗时 | P1 | 已实现（v0.1.1） |
| OPS-009 | 配置与数据迁移 | 幂等升级并验证可读性 | P1 | 已实现（v0.1.0） |
| OPS-010 | 升级前备份与恢复 | 有限备份、失败停止和恢复说明 | P1 | 已实现（v0.1.2） |
| OPS-011 | 数据清理 | 明确清除 Session、缓存或全部应用数据 | P2 | 未开始 |
| OPS-012 | 卸载数据保留策略 | 默认保留并提供显式清理方法 | P2 | 未开始 |
| OPS-013 | Opt-in 遥测 | 用户主动启用的产品指标 | P3 | 未开始 |
| OPS-014 | 隐私控制 | 公布字段、目的、保留期和删除方式 | P1 | 未开始 |

### 4.14 构建、发布与平台支持

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| REL-001 | 精确版本锁定 | 锁定 Tauri、Rust、Node、DSH、Plugin 和依赖 | P0 | 已实现（v0.1.0） |
| REL-002 | 可重复构建 | 使用 lockfile、校验和和固定 CI 环境 | P0 | 已实现（v0.1.0） |
| REL-003 | macOS arm64 `.app` | 生成无需开发环境即可运行的应用 | P0 | 已实现（v0.1.0） |
| REL-004 | macOS `.dmg` | 生成 macOS 安装镜像；正式分发仍依赖签名和公证 | P1 | 已实现（v0.1.0） |
| REL-005 | macOS Developer ID 签名 | 对应用、Node 和 Sidecar 签名 | P1 | 未开始 |
| REL-006 | Apple Notarization | 完成公证和 Gatekeeper 验证 | P1 | 未开始 |
| REL-007 | Windows x64 打包路线 | 准备 WebView2/MSVC/runtime/profile 检查、NSIS 打包 workflow 和本地路线诊断 | P1 | 已实现（v0.1.1） |
| REL-008 | Windows Code Signing | 对应用和 Sidecar 签名 | P1 | 未开始 |
| REL-009 | Linux Desktop | 支持 WebKitGTK 和平台 Sandbox | P3 | 未开始 |
| REL-010 | Auto Update | 检查、下载和安装签名更新 | P1 | 未开始 |
| REL-011 | 原子 Compatibility Set | App、Node、DSH 和 First-party Plugin 同步升级 | P1 | 已实现（v0.1.0） |
| REL-012 | 数据迁移兼容 | 更新后 Session、Settings 和 Credentials 可读 | P1 | 已实现（v0.1.0） |
| REL-013 | 安装/升级/卸载验收清单 | 定义可重复的真实产物验收状态和数据保留检查 | P1 | 已实现（v0.1.1） |
| REL-014 | 跨 WebView 验收 | WKWebView、WebView2 和 WebKitGTK 差异测试 | P1 | 未开始 |
| REL-015 | Mobile | iOS/Android 客户端或伴侣应用 | P3 | 未开始 |
| REL-016 | Release staging 自动化 | 准备公开 release 资产、校验和、license inventory、SBOM/report 引用和 release notes 草稿，但不执行发布 | P1 | 已实现（v0.1.1） |
| REL-017 | Windows x64 installer 验收 | 在真实 Windows 或 CI 中验证实际 NSIS installer、WebView2 首启、Session 创建、退出清理和卸载行为 | P1 | 未开始 |
| REL-018 | 签名二进制分发 | 面向普通用户发布已签名/已公证的平台安装包 | P1 | 未开始 |
| REL-019 | DSH runtime refresh to 0.1.5 | 原子升级 pinned DSH runtime、lockfile、profile、First-party Bundle 兼容、release artifacts 和公开文档到上游 DSH 0.1.5 兼容集 | P0 | 已实现（v0.1.2） |

### 4.15 测试与质量保障

| ID | 功能 | 说明 | 优先级 | 状态 |
|---|---|---|---|---|
| QA-001 | Unit Tests | 配置、状态、错误和边界逻辑 | P0 | 已实现（v0.1.0） |
| QA-002 | DSH Contract Tests | Plugin、Slot、Preset、RPC 和事件契约 | P0 | 已实现（v0.1.0） |
| QA-003 | Integration Tests | Tauri、Sidecar、DSH、Provider 和工具链 | P0 | 已实现（v0.1.0） |
| QA-004 | E2E Tests | 从启动到 Session、工具、审批和恢复 | P0 | 已实现（v0.1.0） |
| QA-005 | Security Tests | Origin/Auth、CSP、XSS、路径与 Secret | P0 | 已实现（v0.1.0） |
| QA-006 | Packaging Tests | 在无开发依赖环境运行安装产物 | P0 | 已实现（v0.1.0） |
| QA-007 | Crash Recovery Tests | Sidecar 和 Tool 子进程异常场景 | P0 | 已实现（v0.1.0） |
| QA-008 | DSH Upgrade Regression | 每次上游升级执行固定回归清单 | P1 | 已实现（v0.1.2） |
| QA-009 | Document Parser Tests | 格式、来源、资源限制和恶意文件 | P1 | 未开始 |
| QA-010 | MCP Failure Isolation | Server 崩溃、超时和协议错误 | P1 | 未开始 |
| QA-011 | Performance Regression | 启动、内存、体积和响应趋势 | P2 | 未开始 |
| QA-012 | Accessibility Tests | 键盘、焦点、状态和辅助技术 | P2 | 未开始 |

## 5. 架构约束，不作为功能排期

以下路线已经明确排除，不进入功能池排期：

- 不使用 Svelte，不自建平行 Web UI 或 DSH Client Adapter。
- 不 fork 官方 DSH Web UI，不 monkey patch DOM，不依赖私有 React 组件。
- 不让 Rust 代理 Agent 的文件系统或 Shell 调用链。
- 不自研第二套 Agent、Session、Sandbox、Permission、Skill、Attachment 或 Model Registry Runtime。
- 不使用 Bun 替代 Node.js。
- 不为体积裁剪 DSH 的核心运行能力和依赖。
- 不要求最终用户安装 Node.js、npm、pnpm 或 DSH。
- 不在运行时安装浮动依赖或自动更新单个 Plugin。
- 不把 `credentials-local` 描述为同一用户进程之间的强安全边界。

## 6. 后续版本规划规则

在决定某项功能进入哪个版本之前，必须完成：

1. 明确用户问题和验收场景。
2. 确认与架构约束一致。
3. 识别 DSH 官方已有能力和公开扩展点。
4. 判断是否需要 Host Plugin、Client/UI Plugin、Skill 或 MCP。
5. 列出依赖、迁移、安全和跨平台影响。
6. 定义可验证的完成标准。
7. 再将功能分配到具体版本。

当前 Roadmap 的状态列记录已发生的实现事实和已确认的活跃版本规划事实。`待实现` 不是实现声明，路线/清单项也不能被理解成真实平台安装包验收通过。任何后续版本规划都应在独立的 Release Requirements 或 Milestone 文档中完成，不直接改写本功能池的优先级含义。
