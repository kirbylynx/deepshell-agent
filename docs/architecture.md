Language: English | [简体中文](architecture.zh.md)

# DeepShell Agent Architecture

> **Tagline:** A desktop agent powered by DeepSeek Harness.
>
> **Status:** V1 Architecture Baseline
>
> **Date:** 2026-09-06
>
> **Scope:** V1 product development, POC, packaging, and release
>
> **Upstream dependency:** DeepSeek Harness (DSH) Developer Preview

In this document, V1 means the MVP architecture baseline starting from `v0.1.0`. `v0.0.x` versions are POC feasibility-validation stages; the public POC closeout is in [`docs/releases/v0.0.1.md`](releases/v0.0.1.md). `docs/plans/` is a local process-document directory and is not published with the public source repository by default.

## 1. Purpose

This document defines DeepShell Agent V1 system boundaries, component responsibilities, process and communication topology, security model, data ownership, packaging/distribution model, and architecture acceptance gates. Implementations may evolve as long as these boundaries remain intact. Any change to process topology, trust boundaries, persistence ownership, or DSH integration approach must first be recorded in an Architecture Decision Record (ADR).

Architecture decisions in this document use three states:

- **Decided:** can directly guide implementation.
- **POC gate:** direction is selected, but the locked source version and runnable artifact must validate it before full development.
- **Deferred:** not part of V1 and should not be built early.

## 2. Product positioning

DeepShell Agent is a desktop application that uses DSH as the Agent Kernel and the official DSH Web UI as the Web Client. Product value is concentrated in:

- native desktop experience;
- General, Coding, and Work user-facing modes;
- clear, safe, recoverable local tool execution;
- first-party Skills, document capabilities, and enterprise workflows;
- controlled model, MCP, and extension capabilities.

DeepShell Agent does not reimplement a general Agent Framework and does not maintain a parallel Web Client. The core split is:

> **Tauri owns the desktop shell and process lifecycle; the official DSH Web UI owns the base interaction; the DSH Runtime owns the Agent; DeepShell differentiates through official extension points.**

## 3. Core architecture decisions

| ID | Decision | Status |
|---|---|---|
| ADR-001 | Use Tauri 2 + Rust as the Desktop Shell | Decided |
| ADR-002 | Reuse the official DSH Web UI directly; differentiated UI uses TypeScript + React DSH Client/UI Plugins | Decided |
| ADR-003 | Use bundled Node.js to run a pinned DSH version; end users do not need Node/npm/pnpm | Decided |
| ADR-004 | Use DSH Agent Runtime; do not build a second Session, Tool, Skill, Sandbox, Approval, or Attachment Runtime | Decided |
| ADR-005 | Rust does not enter the model tool-execution chain; it only handles desktop capabilities and DSH Sidecar lifecycle | Decided |
| ADR-006 | DSH Host serves the official Web UI and API on loopback so UI and DSH API stay same-origin | POC gate |
| ADR-007 | Do not fork the official Web UI, mutate DOM, or import private React implementation; use only public DSH Plugin, Slot, Service, Profile, and Bundle contracts | Decided |
| ADR-008 | Use one application-level DSH Profile; General/Coding/Work map to Session-selected DSH Agent Presets, while React Plugins handle entry points and presentation | Decided |
| ADR-009 | Prefer MCP for external SaaS; high-privilege extensions are limited to first-party Plugins and user-configured MCP Servers | Decided |
| ADR-010 | App, Node, DSH, and first-party Plugins upgrade atomically as one signed version unit | Decided |
| ADR-011 | POC and V1 use official DSH `credentials-local`; system Keychain/Credential Manager Providers are deferred | Decided |

“Full DSH” means keeping the core capabilities and dependencies required by the selected official runtime combination. It does not mean installing or enabling every Provider, experimental package, or third-party Plugin by default. Build artifacts must enable minimum permissions; “complete dependency set” must not be confused with “every capability exposed to the model”.

## 4. System context

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
│                  DSH Host / Agent Runtime                │
└──────────────────┬───────────────┬──────────────┬────────┘
                   │               │              │
                   ▼               ▼              ▼
              Local OS         Model APIs      MCP Servers
            FS / Shell / Git   / Web APIs      / SaaS / DB
```

There are three main trust domains:

1. **Tauri main process:** trusted desktop control plane with window and Sidecar lifecycle authority.
2. **DSH Host:** high-privilege Agent execution plane that accesses Workspace, Shell, network, and credentials according to user authorization.
3. **WebView Renderer:** treated as potentially untrusted frontend code. Even when UI files come from a signed package, the app must defend against XSS, malicious document content, and indirect Prompt Injection.

Model outputs, webpages, attachments, Workspace files, and MCP return values are untrusted input. They must not enter the desktop trusted domain simply because the Agent displays them.

## 5. Runtime topology

### 5.1 Process model

V1 has at least two long-running processes:

```text
DeepShell Agent (Tauri/Rust)
└── Node.js Sidecar
    └── DSH Host
        └── on-demand tool child processes (Shell, MCP stdio, etc.)
```

Responsibilities:

| Process | Responsibilities | Must not own |
|---|---|---|
| Tauri/Rust | Single instance, windows, menu, tray, notifications, updates, Sidecar supervision, minimal native dialogs | Agent loop, tool proxying, Session business state, second permission judgment |
| WebView/DSH React UI | Official interaction, state coordination, streaming rendering, approval, settings, and DeepShell UI extensions | Long-lived secrets, Shell execution, safety-policy decisions |
| Node/DSH | Agent loop, Sessions, models, Tools, Skills, MCP, Workspace, Sandbox, Approval, persistence | Window lifecycle, app updates, system-level UI |

The only normal model tool-call path is:

```text
LLM → DSH → DSH Tool/Capability → OS or External Service
```

The following path must not be introduced:

```text
LLM → DSH → Rust Command → OS
```

Tauri may expose narrow commands for product UI, such as opening native pickers or external links in the system browser. These commands are not Agent Tools and must not be directly callable by the model.

### 5.2 Startup flow

```text
Tauri starts
  → acquire single-instance lock
  → resolve platform app data directory
  → create independent DSH_HOME and runtime directory
  → start pinned Node + DSH on selected loopback bind_address and port 0
  → read actual port, process-scoped startup token, and binding facts from a controlled handshake
  → complete Host health check
  → navigate WebView once to an authorized URL containing the process-scoped token
  → DSH exchanges it for an HttpOnly Session Cookie and cleans the URL
  → Client Connection ready
  → show main window
```

Constraints:

- Sidecar `bind_address` must be the POC-gated loopback IP address, such as `127.0.0.1` or `::1`; it must never bind `0.0.0.0` or any non-loopback address.
- WebView uses a separate `webview_authority`, selected after validating `127.0.0.1` vs `localhost`. `localhost` may be a URL authority but must not be described as the bind address.
- Use port `0` so the OS assigns a free port and fixed-port conflicts are avoided.
- Startup tokens may only be consumed through a dedicated stdout channel. They must not be written to app logs, diagnostic bundles, browser history, or crash reports.
- Ready is accepted only when handshake PID, `bind_address`, port, `webview_authority`, nonce, and Tauri startup record match.
- DeepShell uses the tokenized URL only for first navigation, then immediately moves to a clean URL without query parameters. The token expires with the DSH process. The locked official Host version does not promise one-time token exchange, so “replay must be rejected” must not be treated as an architecture guarantee.
- Host, Origin, and Cookie must match the fixed `webview_authority` and actual port. Wrong Origin, wrong port, wrong Cookie, or cross-instance token must be rejected.
- The main window stays hidden, or shows only an unprivileged boot page, until authentication, official Client Connection, and initial Session/Workspace/Settings synchronization complete.
- Startup timeout must show an actionable error with “Retry” and “Open local diagnostic log”; it must not wait forever.

### 5.3 UI and DSH communication

The V1 baseline uses same-origin communication. DSH Host serves the official Web UI plus DeepShell Client/UI Plugins. WebView loads the POC-gated `http://<webview-authority>:<dynamic-port>`, while DSH Host binds to a separately recorded loopback `bind_address`. UI talks directly to DSH HTTP Remote and WebSocket streams without Rust forwarding business data.

```text
Official DSH Web UI
  + DeepShell Client/UI Plugins
  ├── HTTP POST: commands and queries
  └── WebSocket: event stream, Session follow, Cancellation state
          │
          ▼
       DSH Host
```

This design preserves DSH request correlation, stream recovery, authentication, Host/Origin checks, and Session event semantics. It avoids reimplementing RPC, WebSocket, Cancellation, and streaming state coordination in Rust, and avoids breaking DSH strict same-origin Cookie/Origin constraints through a Tauri custom-protocol page.

Security requirements:

- DSH Host must verify Host, Origin, Cookie, and browser Session; APIs and streams reject anonymous access by default.
- A hostile local origin must not call HTTP APIs, WebSocket streams, or high-privilege Tauri Commands, and must not create Session, Run, or Tool side effects.
- WebView must not navigate to non-DSH loopback origins. External links go to the system browser.
- A strict Content Security Policy (CSP) is required. Default `connect-src` is `'self'`; arbitrary remote scripts are not allowed.
- Assistant messages, rich text, Tool Output, webpage summaries, and document previews must be sanitized. Their HTML/JavaScript, SVG event attributes, and `javascript:` URLs must not execute.
- Tauri capabilities exposed to remote origins must be bound to the main window label and contain only the minimal command set.
- If dynamic loopback origins cannot be safely and precisely constrained by Tauri Capability, the POC must switch to a controlled local bridge rather than widening access to arbitrary remote URLs.

### 5.4 Shutdown, crash, and restart

Normal shutdown:

1. UI stops accepting new Runs and warns about still-running work.
2. Tauri asks DSH to stop gracefully and waits for logs and child-process cleanup.
3. After timeout, Tauri terminates the Sidecar process tree.
4. Runtime directory and single-instance lock are released.

Failure strategy:

- If the Sidecar crashes, UI enters a read-only disconnected state and must not mark unconfirmed Tool Calls as successful.
- Automatic restart uses limited backoff. After repeated failures in one app run, retries stop and diagnostics are shown.
- Persisted Sessions can recover. Tool Calls running at crash time default to `interrupted/unknown`; destructive operations must not be replayed automatically.
- Restart recovery depends on the DSH durable event log, not WebView memory state.

## 6. Component design

### 6.1 Tauri Desktop Shell

Tauri is responsible for:

- main window, auxiliary windows, tray, menu, and shortcuts;
- single instance and Deep Link;
- Sidecar startup, handshake, health check, stop, and crash supervision;
- Auto Update, signature verification, and version switching;
- OS Notification;
- required File/Directory Picker and Open With integration;
- platform app data directory resolution;
- required system-native bridges, without owning Agent business semantics.

Tauri Command design rules:

- Each command must be narrow, with explicit input structures and length limits.
- File paths use canonical paths and validate their intended purpose.
- Do not expose generic high-privilege commands such as `execute_shell`, `read_any_file`, or `write_any_file`.
- Capabilities are split by window and platform and deny by default.
- Rust errors become stable error codes; sensitive internal details go only to redacted logs.

### 6.2 Official DSH Web UI

V1 directly reuses the official DSH Web UI for:

- Chat, Trajectory, and Tool Call display;
- Session creation, recovery, search, pagination, and history;
- Prompt, Attachments, and File References;
- Streaming, Cancellation, queueing, and disconnect recovery;
- Workspace, Models, Skills, MCP, Credentials, and Settings;
- Approval, Ask User, and Permission Preset interactions;
- official Client Model, Remote communication, and state coordination.

DeepShell does not create a Svelte Web App, custom Chat/Session/Settings UI, or custom Client Adapter. Authoritative state for Session, Job, Workspace, Approval, and Tool Result stays in DSH Host. The official Client Model maintains a reconstructable frontend projection.

### 6.3 DeepShell Client/UI Plugins

DeepShell differentiated UI uses the official DSH TypeScript + React plugin system, including:

- product name, logo, tagline, and visual brand;
- General, Coding, and Work entries, selection, and current status;
- Repository, Git, Tests, and Terminal views for Coding;
- Documents, Sources, Knowledge, and Connectors views for Work;
- summary, structure, citations, and preview for first-party Documents Plugin;
- DeepShell-specific settings, Overlay, Conversation View, or Details View.

Extension priority:

```text
Level 1: add independent Client/UI Plugins through public Slots
Level 2: replace specific official UI Plugins through Profile or Bundle Patch
Level 3: replace ui-layout or root composition only when necessary
```

Constraints:

- Do not fork or copy the official Web UI source.
- Do not modify `node_modules`, monkey patch DOM, or depend on fragile CSS selectors.
- Do not import DSH private paths or React components that are not declared public contracts.
- Even at Level 3, replace only the necessary composition layer; do not rewrite Session, Workspace, Streaming, Approval, or other foundations.
- Every first-party Client/UI Plugin must have loading, Slot, communication, and upgrade regression tests pinned to the DSH version.

### 6.4 DSH Host / Agent Runtime

DSH owns:

- Agent Loop and model Providers;
- Sessions, event log, query, and recovery;
- Tool registration, selection, invocation, timeout, and cancellation;
- Workspace, filesystem, Shell, and Git;
- Skills and Agent Presets;
- MCP Client;
- Web Search/Fetch;
- Attachments and File References;
- Sandbox, Approval, Interaction, and Permission Preset;
- Credential References and Model Catalog.

DeepShell Agent does not build a parallel Runtime. When product capability is needed, prefer:

1. compose existing DSH Plugins;
2. write a first-party Plugin that follows DSH capability seams;
3. integrate external services through MCP;
4. put only desktop-native capabilities into Tauri.

### 6.5 Agent Mode and DSH Preset

Concept boundaries:

- **Application Profile:** application-level plugin/configuration composition loaded when DSH Host starts. V1 targets one `desktop` profile. The `v0.0.1` POC reused the official `web` Profile with a `deepshell-poc` Bundle Patch to minimize upstream drift.
- **Agent Mode:** user-visible working mode, mapped to Session-level DSH Agent Presets. A Preset determines Instructions, Skills, Tools, and runtime configuration; the DeepShell React Plugin owns entry points and display.

V1 modes:

| Mode | Default purpose | Default tool group |
|---|---|---|
| General | General Q&A, local tasks, and lightweight research | Basic file references, Web, on-demand Skills |
| Coding | Code understanding, editing, testing, and Git workflows | Workspace FS, Shell, Git, Web, GitHub MCP if enabled |
| Work | Documents, analysis, and enterprise workflows | Documents, Web, authorized enterprise MCP |

Modes may narrow or compose DSH permissions and tools, but may not bypass Session Approval Policy. Mode changes affect new Runs only; running Runs keep their startup snapshot so the tool set does not change mid-run. Add a minimal Host Plugin only when official Agent Presets cannot express the capability. Do not build a parallel Mode Runtime or new configuration DSL.

MCP Servers may register many tools. V1 builds the minimal tool set through Preset, Skill, and user-enabled state. It must not expose every installed MCP tool to every model call. Tool Search/Dynamic Exposure should be introduced only after clear scale thresholds are reached; V1 does not prebuild a complex router.

### 6.6 First-party Documents Plugin

V1 provides one unified first-party Documents Plugin, not separate unrelated Agent Plugins per file format. It contains Host and Client/UI parts: Host parses, searches, and exposes tools; Client/UI shows summaries, provenance, and previews.

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

V1 exposes only a small number of high-level tools to the model:

- `read_document`: read by page, section, Sheet, or range;
- `search_document`: search parsed content and return source locations;
- writing, annotation, or export tools are added later only when real demand exists.

Every result must include source file, version fingerprint, and page/Sheet/cell location. Parsers must enforce limits on file size, page count, row count, decompression ratio, execution time, and memory. Untrusted documents must not load executable macros, external entities, or arbitrary external resources.

Document parsing is a V1 extension milestone after the core Chat/Session/Approval loop is stable. It must not block the foundational desktop shell and DSH integration validation.

## 7. Data and persistence

### 7.1 Data ownership

| Data | Authoritative owner | Notes |
|---|---|---|
| Session/Trajectory/Run | DSH | UI only maintains projection |
| Workspace files | User's original directory | Not copied into app data by default |
| Attachment Blob/reference | DSH | Use content addressing and Session references |
| Agent Preset/Skill/MCP configuration | DSH Profile and app configuration | Changes require validation and versioning |
| Window, theme, desktop preferences | DeepShell Agent | Not written into Session event log |
| API Key/OAuth Token | DSH credentials-local | Settings stores Credential Reference only; secrets live under independent DSH_HOME |
| Diagnostic logs | DeepShell Agent and DSH | Local, rotated, redacted by default |

### 7.2 Directory layout

Actual roots must be resolved through Tauri platform Path APIs. Do not hardcode the user's Home directory. Logical layout:

```text
<Tauri app_data_dir>/  # identifier=com.deepshell.agent; already app-specific
├── app/               # product settings, window state, migration version
├── dsh-home/          # independent DSH_HOME for this app
├── logs/              # rotated and redacted logs
├── runtime/           # PID, handshake files, temporary sockets; cleanable after exit
└── backups/           # limited backups before upgrade migration
```

Requirements:

- Do not read, write, or reuse the user's global DSH CLI Home.
- Workspace paths are stored as references only. Deleting a Session must not delete the Workspace.
- App uninstall keeps user data by default. Data removal must be a separate, explicit, confirmable action.
- Logs and backups have size limits and rotation policies to avoid unbounded growth.

### 7.3 Credentials

POC and V1 use official DSH `credentials-local` to preserve upstream-native behavior:

- startup environment variables have priority;
- managed secrets are stored in DeepShell's independent `$DSH_HOME/.credentials.yaml`;
- Settings stores only Credential References;
- Web UI Secret fields are write-only and return only redacted status after save;
- credential files and directories use official DSH owner-permission restrictions.

DSH Sessions, Settings, and frontend state must not actively hold Secret Values. Normal credential configuration, model calls, error handling, and diagnostic pipelines must not output Secrets to logs, Tool Results, Session messages, crash reports, or screenshots.

Important boundary: `credentials-local` protects mainly through OS user/file permissions. It must not be described as strong isolation between processes running as the same OS user. System credential Providers such as macOS Keychain or Windows Credential Manager are deferred and must follow DSH's public Credential contract.

### 7.4 Telemetry, logs, and diagnostics

Default telemetry is disabled. Any future telemetry must be opt-in, list fields and purposes, and remain separate from DSH event logs.

Logs are local-first:

- include stable error codes, component names, version, PID, port binding facts, and state transitions;
- redact Secret, token, Authorization header, Cookie, exact Prompt content, Tool Output content, and user document text by default;
- diagnostic bundles are user-previewable before export and must not include raw credentials or full local file contents unless explicitly selected.

## 8. Security model

### 8.1 Trust boundaries

| Boundary | Requirement |
|---|---|
| WebView → Tauri | Minimal Capability, fixed window label, strict command schema |
| WebView → DSH | Same-origin Cookie + Host/Origin verification |
| Local webpages → DSH | Rejected unless authenticated and same-origin |
| Model → Tools | DSH Sandbox/Approval/Permission Preset only |
| Tools → Workspace | Follow DSH Workspace and filesystem semantics |
| MCP → External systems | User configuration, credentials, tool minimization, audit hints |
| Untrusted content → UI | Sanitization and no script execution |

### 8.2 Permission and Approval

V1 keeps official DSH permission presets. The default is `workspace-write`:

- Workspace read/write/edit may proceed according to official DSH semantics;
- out-of-workspace writes, permission expansion, and dangerous requests must go through official Approval or fail closed;
- ordinary Shell behavior follows DSH Sandbox/Approval policy;
- DeepShell does not add a second semantic permission layer for POC/V1.

User suggestion accepted for product direction: workspace writes are allowed, out-of-workspace writes require approval, and Shell commands require approval according to the official DSH preset semantics. Implementation must reuse official DSH preset values whenever possible instead of copying and diverging.

Failure behavior:

- Approval timeout, UI disconnect, Sidecar crash, or internal error rejects the request.
- Rejected Approval must not be retried automatically.
- When state is unknown, UI shows `unknown/interrupted`, not success.

### 8.3 Web and MCP safety

Web Search/Fetch and MCP outputs are untrusted. The UI must label source and provenance, and model instructions from external content must not be treated as developer or user instructions.

MCP Servers are installed only with explicit user action. First-party MCP may receive deeper UI integration, but arbitrary third-party MCP cannot receive extra Tauri permissions by default. Tool lists must be minimized by Mode/Skill/task to reduce accidental capability exposure.

## 9. Packaging, signing, and upgrades

### 9.1 Bundled runtime

The app ships with:

- DeepShell Agent Tauri binary;
- bundled Node.js executable and required libraries;
- pinned DSH package and production dependency tree;
- DeepShell first-party Bundle/Profile/Preset/Plugin files;
- runtime lock manifest and checksums.

End users must not need to install Node.js, npm, pnpm, DSH, or build tools.

No floating install is allowed at runtime. If DSH or a first-party Plugin upgrades, App + Node + DSH + Plugin must be built, tested, signed, and released as one compatibility set.

### 9.2 Platform targets

V1 baseline target:

| Platform | Status |
|---|---|
| macOS arm64 | MVP build path available; formal public binary release still requires Developer ID signing and notarization |
| Windows x64 | Runtime assets and build route locked; installer/WebView2/process-tree behavior requires Windows hardware or CI validation |
| Linux | Deferred |
| Intel macOS / Windows arm64 | Deferred unless user demand changes priority |

### 9.3 Package content rules

Release packages must include only the runtime files needed for the target platform. They must not include:

- package-manager caches;
- test fixtures and E2E-only capabilities;
- unredacted logs or diagnostics;
- development-only source maps when not needed;
- private process documents under `docs/plans/`;
- credentials or user data.

Package verification must compare E2E and Release artifacts to prove test-only capabilities are absent from Release builds.

### 9.4 Updates and migration

Updates are atomic:

1. download signed update;
2. verify signature and compatibility metadata;
3. stop Sidecar gracefully;
4. migrate app/DSH configuration idempotently;
5. keep a limited rollback backup;
6. restart DSH Host with the new compatibility set;
7. verify Session, Settings, and credential references are readable.

If migration fails, the app stops and shows recovery instructions instead of silently corrupting data.

## 10. Extension and product capability map

### 10.1 Ownership map

| Capability | Owner |
|---|---|
| Desktop lifecycle, packaging, signing, updater | DeepShell Agent / Tauri |
| Node + DSH Sidecar supervision | DeepShell Agent wrapper, reusing DSH |
| Official DSH Web UI | Reused directly from DSH |
| Chat/Session/Streaming/History/Cancellation | Official DSH Host and Web UI |
| DeepShell Client/UI extensions | TypeScript + React DSH Plugin |
| Workspace/Filesystem/Shell | DSH |
| Sandbox/Approval/Interaction | DSH |
| Models/Credentials | DSH official capability and `credentials-local` |
| Skills/Agent Preset | DSH plus first-party content and React UI Plugin |
| Attachments/File References | DSH |
| Web | DSH Provider |
| MCP base configuration | DSH + DeepShell Agent UI |
| General/Coding/Work | Session Preset + UI |
| DOCX/PDF/PPTX/XLSX read/search/UI | First-party Host + Client/UI Plugin |
| macOS/Windows packaging, signing, upgrade | DeepShell Agent |

### 10.2 Explicitly deferred

- Automatic Auxiliary Vision Router;
- Computer Use and Chrome Control;
- public Plugin Marketplace;
- arbitrary third-party Node Plugin installation;
- complex Profile inheritance, version resolution, and Marketplace;
- custom Agent/Sandbox/Permission/Attachment/Skill Runtime;
- custom Web UI, Svelte, and Client Adapter;
- official DSH Web UI fork, DOM monkey patching, and private React component dependency;
- mobile;
- formal Linux support;
- cross-device Session sync.

Basic image attachment support follows the current model's `inputModalities`: send images when the model supports them; otherwise prompt users to switch models. OCR is a separate document/image tool and does not automatically replace the user's selected model.

## 11. Initial code structure

The following is the V1 logical target structure. The POC does not need to prebuild unused directories. The `v0.0.1` physical layout reused the official `web` Profile: first-party Host/Client entries were combined under `dsh/bundles/deepshell-poc/`, the runtime template lived under `runtime/profile-template/`, and the `deepshell` Preset was mechanically derived from the official `standard` preset with only `tool-web` removed.

```text
deepshell-agent/
├── docs/
│   ├── architecture.md
│   ├── roadmap.md
│   ├── releases/
│   └── adr/
├── src-tauri/
│   ├── capabilities/            # minimal Tauri permissions
│   └── src/
│       ├── sidecar/             # start/stop, handshake, health, process-tree cleanup
│       └── ...
├── runtime/
│   ├── manifest/                # committable runtime lock manifests
│   ├── node/                    # generated/downloaded at build time, ignored publicly
│   └── dsh/                     # installed at build time, ignored publicly
├── dsh/
│   └── bundles/                 # DeepShell Bundle / Profile Patches
└── tests/
    ├── contract/                # DSH public Plugin/Slot/Preset contract tests
    ├── integration/             # Host/Sidecar integration tests
    └── e2e/                     # installed-artifact end-to-end tests
```

Do not create a multi-package monorepo early. Split packages only when independent publishing, clear reuse, or build isolation requires it.

## 12. POC and architecture gates

The POC delivers a runnable macOS arm64 minimal vertical slice with two validation tracks. POC uses Coding Mode only. General/Work, Documents Plugin, MCP, Skills/Attachments management, and complete product UI are out of scope.

### POC-A: official DSH Web UI and public extension contracts

Goal: prove DeepShell can reuse the official DSH Web UI and build a minimal product identity without forking, mutating DOM, or relying on private React implementation.

Must validate:

- official Web UI loads through DeepShell Profile/Bundles;
- first-party Branding Plugin sets product name, tagline, and independent brand identity; in POC this is the Client part of the `@deepshell-agent/dsh-poc` Integration Plugin;
- Branding Plugin uses only public Client/UI Plugin and Slot contracts;
- official Chat, Session, Streaming, Tool Call, Approval, Workspace, Models, and Settings remain available;
- Coding Agent Preset can be selected and its current state displayed;
- automated plugin-loading and compatibility checks are prepared for future explicit DSH upgrades; POC does not require actually upgrading upstream.

Pass criterion: without forking the official Web UI, mutating DOM, or importing private components, the Web Client gains a minimal DeepShell brand identity while core interactions remain functional.

POC-A does not validate General/Work UI, Documents UI, MCP/Skills/Attachments management, or layout reconstruction. Those belong to V1.

Official Web UI entries shipped with the locked DSH version but not included in POC acceptance may stay visible. POC does not add DeepShell custom code or tests for them. MCP Servers and Web Providers that require external configuration are not enabled by default.

### POC-B: Tauri + DSH same-origin Sidecar

Goal: prove official DSH Web UI and Full DSH can run inside Tauri WebView while preserving authentication, communication, lifecycle, and minimal native permission boundaries.

Must validate:

- selected loopback `bind_address`, `webview_authority`, port `0` dynamic allocation, and trusted handshake;
- process-scoped startup token, Cookie, and Host/Origin verification;
- HTTP, WebSocket, refresh, external-link interception, and new-WebView interception;
- precise Tauri remote-origin Capability restriction;
- CSP, hostile-local-origin rejection, and untrusted Assistant/Tool Output sanitization;
- Sidecar crash, limited restart, and shutdown process-tree cleanup;
- no user-installed Node/npm/pnpm requirement;
- macOS arm64 artifact runs without system Node/npm/pnpm;
- official DSH `credentials-local` lives under DeepShell's independent DSH_HOME, and secrets do not enter logs, Sessions, or diagnostic output;
- official DSH `workspace-write` Permission Preset is used; no custom permission plugin is implemented;
- POC uses the `deepshell` Agent Preset, mechanically derived from the locked official `standard` preset, with the only difference being removal of `tool-web`; this does not modify `workspace-write`;
- writes/edits inside Workspace and temporary directories allowed by DSH run directly; out-of-bound writes are first rejected by Sandbox, and one-time permission expansion triggers Approval;
- file reads are not limited by Workspace boundary, and ordinary Shell inside the Sandbox does not require per-command Approval;
- deletes, batch modifications, and destructive Git operations inside Workspace do not receive extra semantic approval in POC; these are recorded risks;
- Approval fails closed on UI disconnect, timeout, or Sidecar crash.

Pass criterion: first launch after install, normal shutdown, and failure recovery are stable; unauthorized local webpages cannot call DSH API or high-privilege Tauri Commands. Uploads, downloads, large messages, multi-window, Auto Update, and data migration are out of POC-B and require later MVP gates.

POC-A and POC-B merge into one integrated runnable POC rather than two isolated demos. A fuller macOS/Windows safety matrix, MCP failure isolation, Documents Plugin, and data migration are V1 gates.

POC uses the official directory picker to create Workspaces. It does not build a Tauri File Picker, Workspace file tree, or file preview. The Agent operates on Workspaces through official file tools; file references use locked-version existing entries, or relative paths in prompts if no entry exists.

## 13. Testing and acceptance strategy

### 13.1 Automated test layers

| Layer | Focus |
|---|---|
| Unit | Branding Plugin, error codes, Mode/Preset, path and configuration validation |
| Contract | Public Plugin, Slot, Preset, RPC, and event semantics of the locked DSH version |
| Integration | Tauri Supervisor + Sidecar + DSH + test Provider/MCP |
| E2E | First launch after install, Session, tools, approval, crash recovery, update |
| Security | Origin/Auth, CSP, XSS, path escape, Secret leakage, malicious MCP/document |
| Packaging | Signing, native modules, uninstall, and data retention for every target platform |

### 13.2 V1 architecture acceptance scenarios

At minimum, cover:

1. Fresh install starts without system Node.
2. App still starts when a fixed port is occupied.
3. Malicious webpages cannot access local DSH APIs.
4. After UI refresh or WebSocket reconnect, Session state and Tool Calls do not duplicate.
5. After a running Shell is cancelled, state and child processes converge.
6. After Sidecar is force-killed, UI does not falsely report success and restart can recover persisted history.
7. Destructive operations do not run when the user rejects, approval times out, or UI disconnects.
8. Secrets do not appear in frontend state, logs, Session export, or diagnostic bundles.
9. DSH upgrades pass contract tests and data migration tests.
10. After app update, Node/DSH/Plugin versions still belong to the same compatibility set.

## 14. Implementation order

1. Establish version manifests, lockfiles, target-platform matrix, and minimal CI.
2. Complete POC-A and freeze the official Web UI public Plugin/Slot/Branding extension boundary.
3. Complete POC-B and freeze startup handshake, same-origin communication, and Sidecar Supervisor.
4. Merge both tracks and complete functional, safety, and recovery acceptance for the macOS arm64 integrated POC.
5. Implement General/Coding/Work Agent Presets, mode entry points, and tool convergence.
6. Add Skills, MCP, and enterprise-connection configuration.
7. Implement first-party Documents Host + Client/UI Plugin.
8. Complete Updater, Deep Link, system integration, and data migration.
9. Complete macOS/Windows installation, signing, update, security, and recovery acceptance.

## 15. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| DSH remains in Developer Preview | Breaking API/package-structure changes | Exact version pinning, public extension contract tests, explicit upgrades |
| Official Slot/Plugin coverage is insufficient | Differentiated UI cannot be added incrementally | Replace a specific UI Plugin or composition layer only at minimal scope; no fork/DOM patch |
| Tauri remote loopback page permission boundary is complex | XSS or malicious local origin may expand privileges | Same-origin auth, navigation lock, minimal Capability, POC-B security tests |
| Node/Plugin/native module cross-platform distribution | Install or signing failure | Per-target builds, real installed-artifact tests, no user-machine dependency install |
| Sandbox platform differences | UI promise differs from actual protection | Capability detection, platform matrix, explicit degradation, block high-risk modes when necessary |
| MCP/documents cause Prompt Injection | Data leakage or wrong tool calls | Mark untrusted content, minimize tools, use Approval, show exfiltration boundaries |
| Upstream brand or trademark confusion | Users may think this is an official DeepSeek/DSH product | Independent brand statement, license/trademark review, no claims of affiliation/authorization/endorsement |
| Document capability scope is too large | Slows core V1 | Implement after core loop; V1 limits to read/search and provenance |

## 16. Non-goals and prohibitions

- Do not maintain a long-lived private DSH fork unless an upstream blocker has a separate ADR and exit plan.
- Do not forward all Agent Tools through Rust.
- Do not make DeepShell Client/UI Plugins the authoritative Session data source.
- Do not install packages or fetch floating dependencies at runtime.
- Do not load every MCP tool, Provider, or Plugin by default.
- Do not describe DSH local credential files as a strong boundary between same-user processes.
- Do not treat a static page returning `200` as a replacement for full Sidecar, Client, model, and toolchain health validation.

## 17. Upstream references

The following links explain upstream capabilities used by this architecture. Concrete implementation still follows the locked source version and POC results:

- [DeepSeek Harness official project and Developer Preview](https://github.com/deepseek-ai/deepseek-harness)
- [DSH Web Client architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/web-client.md)
- [DSH Client Connection and browser authentication boundary](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/connection/README.md)
- [DSH HTTP Server](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/web-server)
- [Tauri: Node.js as a sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)
- [Tauri Capabilities and Remote API Access](https://v2.tauri.app/security/capabilities/)

---

This architecture freezes after both validation tracks of the integrated POC pass. Before that, “the official Web UI can form a minimal DeepShell brand through public contracts”, “the same-origin Sidecar can run safely and stably”, and “the chosen Workspace, Shell, and Approval strategy actually works” are architecture gates and must not be treated as completed product facts in planning.
