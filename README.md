Language: English | [简体中文](README.zh.md)

# DeepShell Agent

> A desktop agent powered by DeepSeek Harness.

DeepShell Agent is a desktop Agent product built on DeepSeek Harness (DSH). It combines the official DSH Web UI, a pinned DSH runtime, bundled Node.js, DeepShell first-party Bundle/Preset integration, and desktop lifecycle management to provide an out-of-the-box, recoverable, packageable local Agent workstation.

DeepShell Agent does not reimplement the Agent Runtime and does not fork the official DSH Web UI. Its architectural boundary is:

> Tauri owns the desktop shell and process lifecycle; the official DSH Web UI owns the base interaction; the DSH Runtime owns the Agent; DeepShell differentiates through official extension points.

## Current status

The current source baseline is `v0.1.2`, a DSH runtime-refresh update on top of the `v0.1.1` release-hardening baseline. It upgrades the pinned DeepSeek Harness runtime to `0.1.5-rc.1`, keeps the official Web UI / public extension-point architecture unchanged, adds a bounded pre-upgrade backup guard for DSH Session data, and is distributed as a macOS arm64 developer-preview release.

Capabilities already included in the source baseline:

- macOS arm64 desktop app build and disk-image generation;
- Windows x64 runtime asset locking and platform-aware path baseline;
- bundled Node.js, so end users do not need to install Node.js, npm, pnpm, or DSH;
- pinned official DSH runtime;
- official DSH React Web UI;
- DeepShell first-party `deepshell-desktop` DSH Bundle;
- `deepshell-coding`, `deepshell-work`, `deepshell-general`, and legacy `deepshell` Agent Presets;
- DeepSeek official API, OpenAI-compatible API, and Responses API routing;
- official `workspace-write` Permission Preset;
- official `credentials-local` credential scheme;
- DeepSeek Web Search and public HTTP(S) Web Fetch;
- DeepSeek `deepseek-flash` / `DeepSeek-V41-Flash` catalog compatibility through the upstream DSH DeepSeek adapter;
- Sidecar dynamic port, token cleanup, Ready Gate, process cleanup, and basic recovery;
- bounded local pre-upgrade backup of `dsh-home/sessions` during the `v0.1.1` to `v0.1.2` runtime refresh;
- redacted local diagnostics, package-size reporting, SBOM baseline, vulnerability-audit entrypoint, and release staging automation;
- E2E/Release artifact security-boundary comparison.

Still required before formal signed/notarized public binary distribution:

- Windows x64 hardware or CI installer acceptance;
- Windows WebView2 first-run, shutdown, and process-tree cleanup acceptance;
- macOS Developer ID signing and Apple notarization;
- Windows code signing;
- release-level license/NOTICE inventory review.

## Main capabilities

### Coding Mode

Coding Mode targets code workspaces. It reuses DSH file, search, Shell, test, Git, Session, and Approval capabilities for code understanding, modification, verification, and change explanation.

### General Mode

General Mode provides a general-purpose Agent entry for Q&A, local tasks, and lightweight research. It is implemented as the `deepshell-general` Agent Preset and uses the official DSH Agent Preset UI.

### Work Mode

Work Mode targets general research and text output. The MVP focuses on:

- Web Search;
- Web Fetch;
- local text/Markdown file read/write;
- structured result capture;
- session-history recovery.

Native Office/PDF/PPTX/XLSX parsing, complex knowledge bases, enterprise connectors, and dedicated document UI are not part of the current baseline.

### Model Providers

The current route supports:

- DeepSeek official API;
- OpenAI-compatible API;
- Responses API.

Models, routes, base URLs, API keys, and model lists are managed through the official DSH Models Settings whenever possible. DeepShell does not create a second model registry or credential system.

## Getting and running

For published binaries, macOS arm64 users can download developer-preview DMGs from GitHub Releases. Formal signed/notarized packages and Windows packages are still separate release gates.

The current source baseline has not completed all formal binary-distribution gates. The public repository is primarily for source publication, architecture review, and reproducible builds. If you want to build from source, see “For contributors” below.

### macOS users

Target platform:

- Apple Silicon Mac;
- macOS 13.0 or later.

For published macOS developer-preview builds, users may download the `.dmg`, drag `DeepShell Agent.app` into Applications, and launch it from there.

Developer-preview DMGs are locally signed for packaging, but they have not completed Developer ID signing or Apple notarization. macOS may show the usual security warning for non-notarized apps. Signing, notarization, and Gatekeeper verification are required before formal public binary distribution.

### Windows users

Target platform:

- Windows 10 22H2 or Windows 11 x64;
- WebView2 Runtime.

After a formal Windows release, Windows users should download the NSIS installer and install through the setup wizard.

The current source baseline has locked Windows x64 runtime assets, but the Windows installer, WebView2 first-run behavior, shutdown, and process-tree cleanup still require validation on Windows hardware or CI.

## Usage

A typical first-run flow is:

1. Open DeepShell Agent.
2. Configure the DeepSeek official API, or add an OpenAI-compatible / Responses API Provider in Models Settings.
3. Select or create a Workspace.
4. Create a General, Coding, or Work Mode Session.
5. Ask the Agent to read, search, or modify Workspace files, run necessary commands, or use Web Search / Web Fetch for research and text output.

## Permissions and credentials

DeepShell Agent uses the official DSH `workspace-write` Permission Preset by default:

- writes inside the Workspace are allowed according to official permission semantics;
- writes outside the Workspace, permission expansion, and dangerous requests must use official Approval or fail closed;
- Shell commands follow official DSH Sandbox/Approval semantics;
- credentials use the official `credentials-local` scheme.

Note: `credentials-local` is not the system Keychain. It can use local file permissions to separate OS users, but it must not be described as a strong security boundary between processes running as the same OS user.

## Build and distribution boundary

The public source repository keeps only source code, tests, build scripts, lock manifests, and public documentation.

It does not commit:

- full runtime;
- installed dependency trees;
- build cache;
- local `.app`, `.dmg`, or installer artifacts;
- E2E and release staging manifests;
- local acceptance evidence;
- logs, screenshots, diagnostic bundles, or real secrets.

Binary packages should be distributed through GitHub Releases or another release channel. A platform-specific license/NOTICE inventory, SBOM, package report, and security-audit report should be regenerated for each binary release artifact.

## License

DeepShell Agent source code is released under the MIT License. See [LICENSE](LICENSE).

Third-party dependencies, bundled runtime components, and binary-release components remain under their own licenses. Before distributing binary packages, regenerate the platform-specific license/NOTICE inventory, SBOM, and release staging assets, then ship or publish the required notices with the release artifact. The current baseline is documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Documentation

- [Architecture](docs/architecture.md) ([中文](docs/architecture.zh.md))
- [Roadmap](docs/roadmap.md) ([中文](docs/roadmap.zh.md))
- [v0.0.1 POC Closeout](docs/releases/v0.0.1.md) ([中文](docs/releases/v0.0.1.zh.md))
- [v0.1.0 MVP Closeout](docs/releases/v0.1.0.md) ([中文](docs/releases/v0.1.0.zh.md))
- [v0.1.1 Release-Hardening Closeout](docs/releases/v0.1.1.md) ([中文](docs/releases/v0.1.1.zh.md))
- [v0.1.2 DSH Runtime Refresh Closeout](docs/releases/v0.1.2.md) ([中文](docs/releases/v0.1.2.zh.md))

`docs/plans/` is a local process-document directory for requirement exploration, design drafts, implementation plans, and acceptance evidence. It is not published with the public source repository by default.

## Branding and icon

DeepShell Agent uses an independent icon language:

- deep-sea-blue rounded square;
- bright cyan-blue minimal scallop;
- large `>_` terminal prompt;
- flat, lightly skeuomorphic, and suitable for modern macOS / Windows desktop icon styles.

Current icon assets:

- `src-tauri/icons/app-icon-source.svg`
- `src-tauri/icons/app-icon-source.png`
- `src-tauri/icons/icon.png`
- `src-tauri/icons/icon.icns`
- `src-tauri/icons/icon.ico`

## Relationship to DeepSeek Harness / DeepSeek

DeepShell Agent is an independent desktop Agent product built on DeepSeek Harness. DeepSeek Harness provides the core Agent Runtime, Web UI, and plugin mechanism; DeepShell Agent provides desktop packaging, runtime distribution, productized Bundle, default modes, diagnostics/recovery, and release workflow.

This project is not an official DeepSeek product and does not imply affiliation, partnership, authorization, or endorsement by DeepSeek. DeepSeek, DeepSeek Harness, and related names belong to their respective owners. They are used here only to describe technical compatibility and upstream dependency relationships.

## For contributors

The following sections are for contributors who build, develop, and validate DeepShell Agent from source.

### Technology stack

- Desktop Shell: Tauri 2 + Rust
- Web Bootstrap: Vite + TypeScript
- UI Runtime: official DSH React Web UI
- Agent Runtime: DeepSeek Harness `0.1.5-rc.1`
- Bundled Node.js: Node.js `24.20.0`
- Package Manager: pnpm `10.30.2`
- Test: Rust test, Vitest, WebdriverIO/Tauri E2E

### Source build flow

The build flow has three stages:

1. Install development dependencies.
2. Prepare the bundled runtime and DSH Profile.
3. Build the platform-specific application package on the target operating system.

The public source repository does not commit the full runtime, installed dependency tree, or local build artifacts. On first build, scripts download and verify the Node.js runtime from `runtime/manifest/runtime-lock.json`, then install the locked DSH production dependency tree from `runtime/manifest/dsh-install/package-lock.json`.

### macOS arm64 build

Build environment:

- Apple Silicon Mac;
- macOS 13.0 or later;
- Xcode Command Line Tools;
- Node.js `>=24.0.0`;
- pnpm `10.30.2`;
- Rust `1.96.0`;
- macOS system dependencies required by Tauri 2.

Prepare the environment:

```bash
xcode-select --install
corepack enable
corepack prepare pnpm@10.30.2 --activate
rustup toolchain install 1.96.0
```

Install project dependencies:

```bash
pnpm install
```

Prepare runtime and Profile:

```bash
pnpm runtime:prepare --target all
pnpm runtime:verify --target all
pnpm profile:prepare
pnpm profile:verify
```

Run in development:

```bash
pnpm dev
```

Build the macOS `.app`, generate `.dmg`, and run the current macOS release checks:

```bash
pnpm package:verified
```

Notes:

- `pnpm package:verified` first builds an E2E-only `.app`, then builds the Release `.app` / `.dmg`, and compares their security boundaries.
- If you only need to rebuild the Release package using an existing E2E manifest, run `pnpm package:mvp`.
- Local `.app` and `.dmg` outputs are under the Tauri build output directory and are ignored by Git.
- The current source baseline does not include Developer ID signing or Apple notarization. Complete them separately before formal binary distribution.

### Windows x64 build

Build environment:

- Windows 10 22H2 or Windows 11 x64;
- WebView2 Runtime;
- Microsoft C++ Build Tools / Visual Studio Build Tools, including MSVC and Windows SDK;
- Node.js `>=24.0.0`;
- pnpm `10.30.2`;
- Rust `1.96.0` with the MSVC toolchain;
- Windows system dependencies required by Tauri 2.

Prepare the environment:

```powershell
corepack enable
corepack prepare pnpm@10.30.2 --activate
rustup toolchain install 1.96.0-msvc
rustup default 1.96.0-msvc
```

Install project dependencies:

```powershell
pnpm install
```

Prepare runtime and Profile:

```powershell
pnpm runtime:prepare --target all
pnpm runtime:verify --target all
pnpm profile:prepare
pnpm profile:verify
```

Run in development:

```powershell
pnpm dev
```

Build the Windows NSIS installer:

```powershell
pnpm package:mvp
```

Notes:

- On Windows, `pnpm package:mvp` calls Tauri to build the NSIS installer.
- Windows installer behavior, WebView2 first run, shutdown, and process-tree cleanup must be accepted on Windows hardware or CI.
- The current source baseline does not include Windows code signing. Complete signing separately before formal binary distribution.

### Common development commands

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

Notes:

- `pnpm check` runs formatting checks, Clippy, TypeScript, unit tests, contract tests, integration tests, security tests, and profile/runtime validation.
- `pnpm runtime:smoke` starts the real DSH Web runtime and validates loopback, token exchange, CSP, Ready Gate, and branding plugin boot-graph integration.
- `pnpm runtime:verify --target all` validates macOS arm64 and Windows x64 runtime lock manifests.
- `pnpm profile:verify` validates DeepShell Bundle/Profile/Preset relationships against the official DSH baseline.
- `pnpm package:e2e` builds the E2E-only app package and captures its artifact manifest.
- `pnpm package:mvp` is platform-aware:
  - macOS: builds `.app`, signs, verifies, and generates `.dmg`;
  - Windows: builds an NSIS installer in a Windows build environment.
- `pnpm package:verified` rebuilds E2E and Release artifacts and compares their security boundaries.
- `pnpm licenses:collect`, `pnpm sbom:generate`, `pnpm package:report`, and `pnpm release:stage` prepare local release-support assets without publishing anything.
- `pnpm diagnostics:collect` exports a local redacted diagnostics bundle under ignored staging.
- `pnpm release:windows:check` reports the Windows x64 packaging route and must not be treated as Windows installer acceptance when run on macOS.
- `pnpm security:audit` creates a vulnerability-audit summary; use `pnpm security:audit -- --dry-run` for deterministic pipeline checks.
