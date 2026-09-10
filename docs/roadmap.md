Language: English | [简体中文](roadmap.zh.md)

# DeepShell Agent Roadmap

> **Product:** DeepShell Agent
>
> **Tagline:** A desktop agent powered by DeepSeek Harness.
>
> **Status:** Feature pool, priority, implementation status, and release-planning baseline; `v0.0.1` POC has completed feasibility validation, `v0.1.0` MVP items are marked, selected `v0.1.1` release-hardening items have landed, and selected `v0.1.2` DSH runtime-refresh items have landed in the current source baseline.
>
> **Date:** 2026-09-10

## 1. Purpose

This document defines DeepShell Agent's version stages, feature pool, and priorities. It explains why a version exists and which capabilities matter more, without committing ahead of time to the version in which any specific feature will start.

Public architecture, release closeout, and feature status are documented in:

- [`docs/architecture.md`](architecture.md)
- [`docs/releases/v0.0.1.md`](releases/v0.0.1.md)
- [`docs/releases/v0.1.0.md`](releases/v0.1.0.md)
- [`docs/releases/v0.1.1.md`](releases/v0.1.1.md)
- [`docs/releases/v0.1.2.md`](releases/v0.1.2.md)

Note: `docs/plans/` is a local process-document directory for requirement exploration, design drafts, implementation plans, and acceptance evidence. It is not published with the public source repository by default. The public Roadmap records only the feature pool, priority, and implementation status.

## 2. Version stages

| Stage | Starting version | Purpose | Meaning of completion |
|---|---|---|---|
| POC | `v0.0.1` | Validate whether the technical architecture and key integrations are feasible | Produce reproducible pass/fail conclusions for key assumptions; does not mean the product is usable |
| MVP | `v0.1.0` | Provide the minimum usable version | Users can complete the core task loop with basic stability, safety, and recovery |

Current POC closeout: `v0.0.1` is `Pass`; see `docs/releases/v0.0.1.md` for the public conclusion. This only means the architecture assumptions were validated and the project can enter MVP scope splitting from `v0.1.0`. It does not mean product-release quality has been reached.

Current MVP scope conclusion: `v0.1.0` is the cross-platform minimum usable version target. It covers macOS arm64 and Windows x64, Coding Mode and Work Mode, official DSH Web UI reuse, DeepSeek official API, OpenAI-compatible API, Responses API, official credential/permission schemes, DeepSeek Web Search, and public HTTP(S) Web Fetch. Detailed process plans stay in local `docs/plans/v0.1.0-mvp/`. Feature-pool priorities in this document still express global relative importance and do not automatically replace version requirements.

Rules:

- The first POC version is fixed as `v0.0.1`.
- Additional feasibility validations use `v0.0.2`, `v0.0.3`, and later `v0.0.x` versions.
- The first version that reaches minimum usability is fixed as `v0.1.0`.
- This document does not assign target versions, start versions, release dates, or completion dates for individual features.
- Before a feature enters a concrete version, scope confirmation, dependency analysis, and acceptance criteria must be completed separately.
- POC/MVP process documents stay in local `docs/plans/`; Roadmap priority does not automatically change confirmed version scope.

## 3. Priority definitions

| Priority | Meaning | Ordering principle |
|---|---|---|
| P0 | Architecture or core-path blocker | Without it, the product route cannot be proven feasible or the basic runtime loop cannot close |
| P1 | Core product capability | Very important for minimum usability, stability, safety, or primary user value |
| P2 | Important enhancement | Significantly improves efficiency, experience, or applicability, but does not block the basic product loop |
| P3 | Long-term or exploratory capability | Should be evaluated after real usage feedback, ecosystem maturity, or additional safety design |

Priority expresses relative importance only. It is not version ownership. Features with the same priority do not necessarily develop at the same time.

The Status column records current implementation facts and confirmed active-version planning facts:

- `Implemented (v0.1.0)` means the feature has landed in the `v0.1.0` MVP and is part of the current validation baseline.
- `Implemented (v0.1.1)` means the feature has landed in the `v0.1.1` release-hardening baseline and is covered by the current validation scope.
- `Implemented (v0.1.2)` means the feature has landed in the `v0.1.2` DSH runtime-refresh baseline and is covered by the current validation scope.
- `Planned (v0.1.1)` means the feature is selected for the active `v0.1.1` planning/development branch, but has not yet landed as an implemented feature.
- `Planned (v0.1.2)` means the feature is selected for the active `v0.1.2` DSH runtime-refresh branch, but has not yet landed as an implemented feature.
- `Not started` means the Roadmap item has not landed as a complete feature. If a composite item is only partially complete, it is still treated as not fully implemented.
- A planned status is not an implementation claim and does not replace Release Requirements, Design, Implementation Plan, or release closeout documents.

## 4. Feature pool

### 4.1 Desktop Shell and runtime

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| DESK-001 | Tauri 2 Desktop Shell | Native desktop application host; platform release acceptance is tracked under Release features | P0 | Implemented (v0.1.0) |
| DESK-002 | Single main window | Hosts the official DSH Web UI | P0 | Implemented (v0.1.0) |
| DESK-003 | Single instance | Subsequent launches focus the existing instance and avoid duplicate Sidecars | P0 | Implemented (v0.1.0) |
| DESK-004 | Bundled Node.js | End users do not need Node/npm/pnpm | P0 | Implemented (v0.1.0) |
| DESK-005 | Full pinned DSH | Distribute an exact pinned official DSH npm version with the app | P0 | Implemented (v0.1.0) |
| DESK-006 | Sidecar startup handshake | Manage PID, dynamic port, nonce, ready, and startup timeout | P0 | Implemented (v0.1.0) |
| DESK-007 | Sidecar health check | Distinguish starting, ready, degraded, and crashed | P0 | Implemented (v0.1.0) |
| DESK-008 | Graceful Sidecar shutdown | Exit after persistence, then clean up the process tree after timeout | P0 | Implemented (v0.1.0) |
| DESK-009 | Sidecar crash recovery | Limited automatic restart, interrupted state, and manual recovery entry | P0 | Implemented (v0.1.0) |
| DESK-010 | Independent DSH_HOME | Do not pollute or reuse the user's existing DSH CLI environment | P0 | Implemented (v0.1.0) |
| DESK-011 | Dynamic loopback port | Bind only to loopback and avoid fixed-port conflicts | P0 | Implemented (v0.1.0) |
| DESK-012 | Basic menu | About, Quit, and version information | P0 | Implemented (v0.1.0) |
| DESK-013 | External link handling | Open non-local links in the system browser | P0 | Implemented (v0.1.0) |
| DESK-014 | Tray | Tray status and common actions | P2 | Not started |
| DESK-015 | Native menu and shortcuts | Complete desktop menu and global/app shortcuts | P2 | Not started |
| DESK-016 | OS notifications | Notify when long tasks finish, fail, or require user action | P2 | Not started |
| DESK-017 | Deep Link | Open the app, Workspace, or Session through protocol links | P2 | Not started |
| DESK-018 | Auto Launch | Start after login according to user configuration | P3 | Not started |
| DESK-019 | Open With | Enter DeepShell from OS file associations | P2 | Not started |
| DESK-020 | Reveal in Folder | Locate files in the system file manager from the app | P2 | Not started |
| DESK-021 | Native File/Directory Picker | Provide minimal Tauri bridging only when official pickers are insufficient | P2 | Not started |
| DESK-022 | Multi-window | Support independent Session, settings, or auxiliary windows | P3 | Not started |

### 4.2 Official Web UI and product interface

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| UI-001 | Official DSH Web UI | Reuse the official React Web Client directly | P0 | Implemented (v0.1.0) |
| UI-002 | DeepShell Branding Plugin | Product name, tagline, logo, and basic brand entry | P0 | Implemented (v0.1.0) |
| UI-003 | Formal visual brand | Final logo, icon, color, theme, and app assets | P1 | Implemented (v0.1.0) |
| UI-004 | Agent Mode entry | Show and switch General, Coding, and Work through the official Agent Preset UI and a DeepShell Mode header indicator | P1 | Implemented (v0.1.1) |
| UI-005 | Coding Repository view | Show repository, branch, status, and related actions | P1 | Not started |
| UI-006 | Git view | Show diff, changes, commits, and worktree state | P1 | Not started |
| UI-007 | Tests view | Show test execution, progress, and failure details | P1 | Not started |
| UI-008 | Terminal view | Show controlled terminal and command-run state | P1 | Not started |
| UI-009 | Work Documents view | Show documents, summaries, structure, and sources | P1 | Not started |
| UI-010 | Sources/Knowledge view | Show sources, knowledge content, and citation relationships | P2 | Not started |
| UI-011 | Connectors view | Show MCP/SaaS connections and status | P1 | Not started |
| UI-012 | DeepShell Settings | Extend product-specific settings | P1 | Not started |
| UI-013 | Overlay | Provide a floating surface for short interactions | P2 | Not started |
| UI-014 | Conversation View extension | Add DeepShell-specific conversation presentation | P2 | Not started |
| UI-015 | Details View | Show details for runs, tools, or business objects | P2 | Not started |
| UI-016 | Layout Composition replacement | Minimally replace layout composition when official Slots are insufficient | P3 | Not started |
| UI-017 | Internationalization | Reuse official Locale and override DeepShell-owned copy | P1 | Not started |
| UI-018 | Accessibility | Keyboard operation, focus, status hints, and assistive technology support | P1 | Not started |

### 4.3 DSH Profile, Bundle, and extension system

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| EXT-001 | DeepShell Desktop Profile | Combine official Bundles, DeepShell Plugins, and configuration | P0 | Implemented (v0.1.0) |
| EXT-002 | DeepShell Bundle/Patch | Add or replace capabilities through the public configuration layer | P0 | Implemented (v0.1.0) |
| EXT-003 | Client/UI Plugin foundation | Use TypeScript + React and public Slots | P0 | Implemented (v0.1.0) |
| EXT-004 | Host Plugin foundation | Use public Service, Tool, Provider, and lifecycle contracts | P1 | Implemented (v0.1.0) |
| EXT-005 | Plugin compatibility tests | Regression coverage for loading, Slots, and communication on the pinned DSH version | P0 | Implemented (v0.1.0) |
| EXT-006 | Plugin Inventory | Show currently loaded official and first-party Plugins | P2 | Not started |
| EXT-007 | Third-party local Plugin install | Install external Plugins under an explicit security model | P3 | Not started |
| EXT-008 | Plugin Marketplace | Discover, install, rate, and update Plugins | P3 | Not started |
| EXT-009 | Plugin signing and source verification | Verify publisher, integrity, and version source | P3 | Not started |
| EXT-010 | Agent Mode Marketplace | Distribute user-facing mode bundles | P3 | Not started |
| EXT-011 | Complex Profile/Mode inheritance | Resolve versions, dependencies, inheritance, and conflicts | P3 | Not started |
| EXT-012 | DSH 0.1.5 Plugin API compatibility | Keep DeepShell first-party Client/UI and Bundle integration compatible with upstream DSH 0.1.5 public extension contracts | P0 | Implemented (v0.1.2) |

### 4.4 Models and credentials

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| MODEL-001 | DeepSeek official Provider | Configure API key and complete real model calls | P0 | Implemented (v0.1.0) |
| MODEL-002 | Official Models Settings | Reuse Provider, model, and credential settings UI | P0 | Implemented (v0.1.0) |
| MODEL-003 | Model Catalog | Use the official DSH model catalog | P1 | Implemented (v0.1.0) |
| MODEL-004 | Model capability hints | Show and validate input capabilities based on `inputModalities` | P1 | Not started |
| MODEL-005 | Multiple Providers | Integrate other officially supported model Providers | P1 | Implemented (v0.1.0) |
| MODEL-006 | Custom Provider | Configure OpenAI-compatible and similar custom endpoints | P2 | Implemented (v0.1.0) |
| MODEL-007 | Model selection | Select and persist model facts per Session | P1 | Implemented (v0.1.0) |
| MODEL-008 | Provider availability status | Distinguish unconfigured, authentication failure, and service unavailable | P1 | Implemented (v0.1.0) |
| MODEL-009 | DeepSeek-V4.1-Flash compatibility | Adopt the upstream DeepSeek adapter/catalog behavior for `DeepSeek-V41-Flash` / `deepseek-flash`, including capability and default-model verification | P0 | Implemented (v0.1.2) |
| CRED-001 | DSH credentials-local | Credential Reference and write-only Secret configuration | P0 | Implemented (v0.1.0) |
| CRED-002 | Secret redaction | Secrets do not enter Sessions, logs, or diagnostic bundles | P0 | Implemented (v0.1.0) |
| CRED-003 | macOS Keychain Provider | System credential Provider following the DSH contract | P2 | Not started |
| CRED-004 | Windows Credential Manager | Windows system credential Provider | P2 | Not started |
| CRED-005 | Linux Secret Service | Linux system credential Provider | P3 | Not started |
| CRED-006 | OAuth/native authentication | Authorization flow for Providers or SaaS | P2 | Not started |

### 4.5 Agent Mode and workflows

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| MODE-001 | Coding Mode | Code understanding, editing, testing, and Git workflows | P0 | Implemented (v0.1.0) |
| MODE-002 | General Mode | General Q&A, local tasks, and lightweight research | P1 | Not started |
| MODE-003 | Work Mode | Documents, analysis, and enterprise workflows | P1 | Implemented (v0.1.0) |
| MODE-004 | Coding Preset mapping | Map Coding Mode to a Session-level official Preset | P0 | Implemented (v0.1.0) |
| MODE-005 | Work Preset mapping | Map Work Mode to a Session-level official Preset | P1 | Implemented (v0.1.0) |
| MODE-006 | Instructions configuration | Compose instructions for different Modes | P1 | Not started |
| MODE-007 | Skills configuration | Compose default Skills for different Modes | P1 | Not started |
| MODE-008 | Tool Groups | Constrain tool sets for different Modes | P1 | Not started |
| MODE-009 | Context Strategy | Select context strategies for different Modes | P2 | Not started |
| MODE-010 | Mode-switch snapshot | New Runs use new settings; running Runs keep their startup snapshot | P1 | Implemented (v0.1.0) |
| MODE-011 | Research/Data/Recruiting/Engineering Mode | Extend work modes based on real demand | P2 | Not started |
| MODE-012 | General Preset mapping | Map General Mode to a Session-level official Preset | P1 | Implemented (v0.1.1) |

### 4.6 Session, Conversation, and runtime state

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| SESSION-001 | Create Session | Create conversations inside a Workspace | P0 | Implemented (v0.1.0) |
| SESSION-002 | Session list and switch | Browse multiple Workspaces and Sessions | P0 | Implemented (v0.1.0) |
| SESSION-003 | History | Persist and restore messages and tool events | P0 | Implemented (v0.1.0) |
| SESSION-004 | Streaming | Incrementally render Assistant responses | P0 | Implemented (v0.1.0) |
| SESSION-005 | Cancellation | Cancel Runs and converge state correctly | P0 | Implemented (v0.1.0) |
| SESSION-006 | Tool Call display | Show parameters, status, results, and errors | P0 | Implemented (v0.1.0) |
| SESSION-007 | Trajectory | View the full Agent run trajectory | P1 | Not started |
| SESSION-008 | Approval interaction | Show authorization requests and record results | P0 | Implemented (v0.1.0) |
| SESSION-009 | Ask User | Agent asks structured questions to the user | P1 | Not started |
| SESSION-010 | Queue/Job status | Show queued, running, completed, and failed states | P1 | Implemented (v0.1.0) |
| SESSION-011 | Disconnect/reconnect | Recover event streams without duplicating durable messages | P0 | Implemented (v0.1.0) |
| SESSION-012 | Crash recovery | Restore persisted history and mark interrupted work | P0 | Implemented (v0.1.0) |
| SESSION-013 | Session search | Find Sessions by title or content | P1 | Not started |
| SESSION-014 | Pagination | Page through large histories | P1 | Not started |
| SESSION-015 | Title generation and editing | Generate titles automatically and allow edits | P2 | Not started |
| SESSION-016 | Archive/Unarchive | Manage inactive Sessions | P2 | Not started |
| SESSION-017 | Fork | Create a branch Session from existing history | P2 | Not started |
| SESSION-018 | Delete | Delete Session data with explicit confirmation | P2 | Not started |
| SESSION-019 | Session export | Export auditable conversation and run records | P2 | Not started |
| SESSION-020 | Cross-device Session sync | Sync and restore Sessions across devices | P3 | Not started |
| SESSION-021 | DSH Session format V3 migration guard | Protect the DSH runtime refresh with scoped pre-upgrade Session backup, non-downgrade warning, and failure-safe messaging | P0 | Implemented (v0.1.2) |
| SESSION-022 | Real old-session upgrade acceptance | Manually validate that representative `v0.1.1` Sessions open or migrate correctly under `v0.1.2` before tag/release publication | P0 | Not started |

### 4.7 Workspace, files, Shell, and Git

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| WORK-001 | Workspace selection | Reuse the official native/browse directory picker | P0 | Implemented (v0.1.0) |
| WORK-002 | Workspace registration and switching | Manage multiple Workspace references | P0 | Implemented (v0.1.0) |
| WORK-003 | File read | Read content through the official DSH filesystem | P0 | Implemented (v0.1.0) |
| WORK-004 | File write and edit | Modify Workspaces through official DSH tools | P0 | Implemented (v0.1.0) |
| WORK-005 | File search | Use official glob/grep capabilities to find files and content | P1 | Implemented (v0.1.0) |
| WORK-006 | File References | Reference Workspace files in prompts | P1 | Implemented (v0.1.0) |
| WORK-007 | Workspace file tree | Browse directories and files in the sidebar | P1 | Not started |
| WORK-008 | Text file preview | Safely preview files in the UI | P1 | Not started |
| WORK-009 | Repository panel | Show repository state and structure | P1 | Not started |
| WORK-010 | Shell | Use official DSH Bash/Terminal tools | P0 | Implemented (v0.1.0) |
| WORK-011 | Git | Support status, diff, commit, and branch workflows | P1 | Implemented (v0.1.0) |
| WORK-012 | Test Runner | Run and display test results | P1 | Implemented (v0.1.0) |
| WORK-013 | Terminal Session | Provide persistent, observable terminal sessions | P1 | Not started |
| WORK-014 | Attachments | Use DSH content addressing and Session references | P1 | Not started |
| WORK-015 | Workspace multi-root | Combine multiple roots in one work context | P3 | Not started |

### 4.8 Sandbox, Approval, and safety

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| SAFE-001 | Official workspace-write Preset | Use official Sandbox and Approval semantics | P0 | Implemented (v0.1.0) |
| SAFE-002 | Permission Preset UI | Show and switch the actual effective permission | P1 | Implemented (v0.1.0) |
| SAFE-003 | Sandbox escalation | Request one-time authorization for out-of-bound actions through the official flow | P0 | Implemented (v0.1.0) |
| SAFE-004 | Fail-closed Approval | Reject on no answer, disconnect, timeout, or error | P0 | Implemented (v0.1.0) |
| SAFE-005 | Minimal Tauri Capability | Restrict permissions by window, platform, and command | P0 | Implemented (v0.1.0) |
| SAFE-006 | Loopback Host/Origin authentication | Prevent unauthorized local pages from accessing DSH | P0 | Implemented (v0.1.0) |
| SAFE-007 | WebView navigation restriction | Forbid arbitrary remote navigation and windows | P0 | Implemented (v0.1.0) |
| SAFE-008 | CSP | Forbid remote scripts and restrict connection sources | P0 | Implemented (v0.1.0) |
| SAFE-009 | Untrusted content sanitization | Safely render Markdown, webpages, documents, and Tool Output | P1 | Not started |
| SAFE-010 | Safety Guard | Add controls for deletion, batch overwrite, and destructive Git operations | P2 | Not started |
| SAFE-011 | Out-of-workspace read control | Add stronger data-boundary policies when needed | P2 | Not started |
| SAFE-012 | Platform Sandbox capability matrix | Show actual macOS/Windows/Linux protection and degradation | P1 | Not started |
| SAFE-013 | MCP permission and source display | Show commands, URLs, tools, credentials, and risks | P1 | Not started |
| SAFE-014 | Plugin security policy | Restrict sources and loading for high-privilege extensions | P1 | Not started |
| SAFE-015 | SBOM | Generate a software bill of materials | P1 | Implemented (v0.1.1) |
| SAFE-016 | Vulnerability scanning | Scan Rust, Node, and packaged dependencies | P1 | Implemented (v0.1.1) |
| SAFE-017 | Audit trail | Link Runs, Tool Calls, Approvals, and configuration changes | P1 | Not started |
| SAFE-018 | Prompt Injection protection | Mark untrusted sources and control tool/exfiltration boundaries | P1 | Not started |

### 4.9 Skills

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| SKILL-001 | DSH Skills Runtime | Reuse official Skill capability directly | P1 | Not started |
| SKILL-002 | Bundled Skills | Ship DeepShell first-party Skills with the app | P1 | Not started |
| SKILL-003 | Skills UI | View, enable, and manage Skills | P1 | Not started |
| SKILL-004 | PR Review Skill | Code review workflow | P2 | Not started |
| SKILL-005 | Contract Review Skill | Contract review workflow | P2 | Not started |
| SKILL-006 | Research Skill | Research and evidence-capture workflow | P2 | Not started |
| SKILL-007 | Excel Analysis Skill | Spreadsheet analysis workflow | P2 | Not started |
| SKILL-008 | Recruiting Skill | Recruiting and candidate-processing workflow | P2 | Not started |
| SKILL-009 | Tender Analysis Skill | Tender/bid document analysis workflow | P2 | Not started |

### 4.10 Documents Plugin

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| DOC-001 | Unified Documents Plugin | One first-party Host + Client/UI Plugin | P1 | Not started |
| DOC-002 | DOCX structured parsing | Extract paragraphs, tables, styles, and source locations | P1 | Not started |
| DOC-003 | PDF parsing | Extract born-digital PDF text and layout | P1 | Not started |
| DOC-004 | PPTX structured parsing | Extract slides, text, and structure | P1 | Not started |
| DOC-005 | XLSX structured parsing | Extract Sheets, ranges, tables, and cells | P1 | Not started |
| DOC-006 | `read_document` | Read by page, section, Sheet, or range | P1 | Not started |
| DOC-007 | `search_document` | Search content and return source locations | P1 | Not started |
| DOC-008 | Document source and version fingerprint | Preserve file, version, page/Sheet/cell provenance | P1 | Not started |
| DOC-009 | Document Summary UI | Show summaries and basic metadata | P1 | Not started |
| DOC-010 | Structure/Citations UI | Show structure and citation locations | P1 | Not started |
| DOC-011 | Page/Slide/Sheet Preview | Safe document preview | P1 | Not started |
| DOC-012 | `render_document` | Render document content into inspectable artifacts | P2 | Not started |
| DOC-013 | `extract_tables` | Extract tables through a unified interface | P2 | Not started |
| DOC-014 | OCR | Process scanned documents on demand | P2 | Not started |
| DOC-015 | Document writing and annotation | Modify, annotate, or generate documents | P2 | Not started |
| DOC-016 | Document export | Export processing results and derived artifacts | P2 | Not started |
| DOC-017 | Parser resource limits | File size, page count, decompression ratio, time, and memory limits | P1 | Not started |
| DOC-018 | Malicious document protection | Forbid macros, external entities, and unauthorized external resources | P1 | Not started |

### 4.11 MCP, SaaS, and Web

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| INT-001 | DSH MCP Client | Reuse official MCP capability | P1 | Not started |
| INT-002 | MCP configuration UI | Add, enable, disable, and diagnose Servers | P1 | Not started |
| INT-003 | MCP Tool convergence | Expose only task-relevant tools to the model | P1 | Not started |
| INT-004 | GitHub MCP | Repository, Issue, PR, and related capabilities | P1 | Not started |
| INT-005 | Notion MCP | Page and knowledge-content connection | P2 | Not started |
| INT-006 | Slack MCP | Messaging and collaboration connection | P2 | Not started |
| INT-007 | Database MCP | Database query and controlled operation | P2 | Not started |
| INT-008 | Office/SaaS MCP | Other enterprise-work service connections | P2 | Not started |
| INT-009 | Web Search | Search through the DSH Web Provider | P1 | Implemented (v0.1.0) |
| INT-010 | Web Fetch | Fetch webpage content and preserve sources | P1 | Implemented (v0.1.0) |
| INT-011 | Web Provider configuration | Manage search or fetch services | P1 | Implemented (v0.1.0) |
| INT-012 | Dedicated enterprise Host Plugin | Use when MCP cannot satisfy performance, permission, or audit needs | P2 | Not started |
| INT-013 | Tool Search | Dynamic discovery after tool scale increases | P2 | Not started |
| INT-014 | Dynamic Exposure | Expose tools dynamically by Mode/Skill/task | P2 | Not started |

### 4.12 Images, multimodality, and automatic operation

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| MEDIA-001 | Image attachments | Reuse DSH Attachments | P1 | Not started |
| MEDIA-002 | Native multimodality | Send images through the DSH native path when supported by the model | P1 | Not started |
| MEDIA-003 | Capability mismatch prompt | Prompt users to switch models when images are unsupported | P1 | Not started |
| MEDIA-004 | Auxiliary Vision Router | Automatically call an auxiliary vision model and return results | P3 | Not started |
| MEDIA-005 | Computer Use | Operate desktop applications and system UI | P3 | Not started |
| MEDIA-006 | Chrome Control | Control the browser and perform web tasks | P3 | Not started |

### 4.13 Data, observability, and privacy

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| OPS-001 | Platform data directories | Separate app, dsh-home, logs, runtime, and backups | P0 | Implemented (v0.1.0) |
| OPS-002 | Session persistence | Use DSH durable event log as authoritative fact | P0 | Implemented (v0.1.0) |
| OPS-003 | Attachment persistence | Content addressing, checksum, and Session references | P1 | Not started |
| OPS-004 | Structured logging | Link app, DSH, Session, Run, and Tool Call | P0 | Implemented (v0.1.0) |
| OPS-005 | Log redaction and rotation | Control secrets, content, and disk growth | P0 | Implemented (v0.1.0) |
| OPS-006 | Runtime state | Distinguish Desktop, Sidecar, Client, Provider, and MCP states | P0 | Implemented (v0.1.0) |
| OPS-007 | Diagnostic bundle | User-previewable, redacted diagnostic export | P1 | Implemented (v0.1.1) |
| OPS-008 | Performance observability | Startup, memory, package size, and runtime duration | P1 | Implemented (v0.1.1) |
| OPS-009 | Configuration and data migration | Idempotent upgrades with readability verification | P1 | Implemented (v0.1.0) |
| OPS-010 | Pre-upgrade backup and recovery | Limited backups, fail-stop, and recovery instructions | P1 | Implemented (v0.1.2) |
| OPS-011 | Data cleanup | Explicitly clear Sessions, cache, or all app data | P2 | Not started |
| OPS-012 | Uninstall data-retention policy | Retain by default and provide an explicit cleanup method | P2 | Not started |
| OPS-013 | Opt-in telemetry | Product metrics actively enabled by the user | P3 | Not started |
| OPS-014 | Privacy controls | Publish fields, purposes, retention periods, and deletion method | P1 | Not started |

### 4.14 Build, release, and platform support

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| REL-001 | Exact version locking | Lock Tauri, Rust, Node, DSH, Plugins, and dependencies | P0 | Implemented (v0.1.0) |
| REL-002 | Reproducible builds | Use lockfiles, checksums, and fixed CI environments | P0 | Implemented (v0.1.0) |
| REL-003 | macOS arm64 `.app` | Generate an app that runs without development dependencies | P0 | Implemented (v0.1.0) |
| REL-004 | macOS `.dmg` | Generate a macOS disk image; formal distribution still depends on signing and notarization | P1 | Implemented (v0.1.0) |
| REL-005 | macOS Developer ID signing | Sign the app, Node, and Sidecar | P1 | Not started |
| REL-006 | Apple Notarization | Complete notarization and Gatekeeper verification | P1 | Not started |
| REL-007 | Windows x64 packaging route | Prepare WebView2/MSVC/runtime/profile checks, NSIS packaging workflow, and local route diagnostics | P1 | Implemented (v0.1.1) |
| REL-008 | Windows Code Signing | Sign the app and Sidecar | P1 | Not started |
| REL-009 | Linux Desktop | Support WebKitGTK and platform Sandbox | P3 | Not started |
| REL-010 | Auto Update | Check, download, and install signed updates | P1 | Not started |
| REL-011 | Atomic Compatibility Set | Upgrade App, Node, DSH, and first-party Plugins together | P1 | Implemented (v0.1.0) |
| REL-012 | Data migration compatibility | Sessions, Settings, and Credentials remain readable after updates | P1 | Implemented (v0.1.0) |
| REL-013 | Install/upgrade/uninstall acceptance checklist | Define repeatable real-artifact acceptance status and data-retention checks | P1 | Implemented (v0.1.1) |
| REL-014 | Cross-WebView acceptance | WKWebView, WebView2, and WebKitGTK difference testing | P1 | Not started |
| REL-015 | Mobile | iOS/Android client or companion app | P3 | Not started |
| REL-016 | Release staging automation | Prepare public release assets, checksums, license inventory, SBOM/report references, and release notes drafts without publishing | P1 | Implemented (v0.1.1) |
| REL-017 | Windows x64 installer validation | Validate the actual NSIS installer, WebView2 first run, Session creation, shutdown cleanup, and uninstall behavior on real Windows or CI | P1 | Not started |
| REL-018 | Signed binary distribution | Publish signed/notarized platform installers for general users | P1 | Not started |
| REL-019 | DSH runtime refresh to 0.1.5 | Atomically upgrade pinned DSH runtime, lockfiles, profile, first-party Bundle compatibility, release artifacts, and public docs to the upstream DSH 0.1.5 compatibility set | P0 | Implemented (v0.1.2) |

### 4.15 Testing and quality assurance

| ID | Feature | Description | Priority | Status |
|---|---|---|---|---|
| QA-001 | Unit Tests | Configuration, state, error, and boundary logic | P0 | Implemented (v0.1.0) |
| QA-002 | DSH Contract Tests | Plugin, Slot, Preset, RPC, and event contracts | P0 | Implemented (v0.1.0) |
| QA-003 | Integration Tests | Tauri, Sidecar, DSH, Provider, and toolchain | P0 | Implemented (v0.1.0) |
| QA-004 | E2E Tests | From startup to Session, tools, approval, and recovery | P0 | Implemented (v0.1.0) |
| QA-005 | Security Tests | Origin/Auth, CSP, XSS, paths, and secrets | P0 | Implemented (v0.1.0) |
| QA-006 | Packaging Tests | Run installed artifacts without development dependencies | P0 | Implemented (v0.1.0) |
| QA-007 | Crash Recovery Tests | Sidecar and Tool child-process abnormal scenarios | P0 | Implemented (v0.1.0) |
| QA-008 | DSH Upgrade Regression | Run fixed regression checklist for every upstream upgrade | P1 | Implemented (v0.1.2) |
| QA-009 | Document Parser Tests | Format, provenance, resource limits, and malicious files | P1 | Not started |
| QA-010 | MCP Failure Isolation | Server crash, timeout, and protocol errors | P1 | Not started |
| QA-011 | Performance Regression | Startup, memory, package size, and response trends | P2 | Not started |
| QA-012 | Accessibility Tests | Keyboard, focus, status, and assistive technology | P2 | Not started |

## 5. Architecture constraints, not feature schedule

The following routes are explicitly excluded and do not enter the feature schedule:

- No Svelte, no parallel Web UI, and no DSH Client Adapter.
- No official DSH Web UI fork, no DOM monkey patching, and no dependency on private React components.
- Rust must not proxy Agent filesystem or Shell calls.
- No second Agent, Session, Sandbox, Permission, Skill, Attachment, or Model Registry Runtime.
- No Bun replacement for Node.js.
- No package-size trimming that removes DSH core runtime capabilities or dependencies.
- End users must not be required to install Node.js, npm, pnpm, or DSH.
- No runtime installation of floating dependencies or automatic update of individual Plugins.
- Do not describe `credentials-local` as a strong security boundary between same-user processes.

## 6. Planning rules for later versions

Before assigning a feature to a version, complete:

1. Define the user problem and acceptance scenarios.
2. Confirm alignment with architecture constraints.
3. Identify existing official DSH capabilities and public extension points.
4. Decide whether a Host Plugin, Client/UI Plugin, Skill, or MCP is needed.
5. List dependency, migration, security, and cross-platform impacts.
6. Define verifiable completion criteria.
7. Assign the feature to a concrete version only after the above is done.

The Status column in this Roadmap records implemented facts and confirmed active-version planning facts. A planned item is not an implementation claim, and route/checklist items must not be read as real platform installer acceptance. Later version planning should happen in separate Release Requirements or Milestone documents, not by changing the meaning of priorities in this feature pool.
