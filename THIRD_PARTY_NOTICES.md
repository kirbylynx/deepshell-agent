Language: English | [简体中文](THIRD_PARTY_NOTICES.zh.md)

# Third Party Notices

DeepShell Agent source code is released under the MIT License. DeepShell Agent also bundles or builds against third-party software that remains under each component's own license. This file records the public source-repository notice baseline; it is not legal advice.

## Project source license

The DeepShell Agent source repository is licensed under the MIT License. See `LICENSE`.

This project license does not change the licenses of bundled or linked third-party components. Binary releases must include the notices and license texts required by the exact dependency set shipped in that release artifact.

## Distributed runtime components

| Component | Locked version | Declared license | License source |
|---|---:|---|---|
| Node.js | 24.20.0 | Node.js license plus bundled third-party notices | downloaded during `pnpm runtime:prepare` |
| DeepSeek Harness CLI (`@deepseek-ai/dsh`) | 0.1.2-rc.1 | MIT | installed from `runtime/manifest/dsh-install/package-lock.json` |
| React | 18.3.1 | MIT | installed as part of the locked DSH/runtime dependency set |
| sharp/libvips Darwin arm64 runtime | 1.3.3 | LGPL-3.0-or-later | package metadata and bundled license files |

The DSH production dependency tree is installed from `runtime/manifest/dsh-install/package-lock.json` with `npm ci`. The generated runtime, installed dependency tree, cache, staging manifests, and local evidence files are build artifacts and are not committed to the public source repository.

A complete machine-readable package/version/license inventory should be regenerated for each distributable release package and shipped or published with that release artifact as appropriate. In `v0.1.1`, `pnpm licenses:collect` writes the current inventory to ignored release staging, `pnpm sbom:generate` derives a baseline SBOM from that inventory, and `pnpm security:audit` prepares a vulnerability-audit report for release review.

LGPL-licensed runtime components such as libvips require special release handling: preserve the license text and notices, document whether the component was modified, and provide the source or source-location information required by the component license.

## Build-time and application-framework components

The application uses Tauri 2 and Rust crates. Its build/test toolchain uses pnpm, Vite, TypeScript, Vitest, and WebdriverIO. Exact versions come from `src-tauri/Cargo.lock`, `pnpm-lock.yaml`, and `runtime/manifest/runtime-lock.json`. The generated inventory lists all Cargo registry packages and direct npm build/test dependencies.

`pnpm package:report` and `pnpm release:stage` prepare aggregate package metrics, checksums, SBOM references, security-audit references, and release-note drafts locally. These commands do not publish releases or upload assets by themselves.

`tauri-plugin-wdio-webdriver` and WebdriverIO tooling are test-only. Package comparison must prove that the WebDriver Rust plugin and the `poc-e2e` capability are absent from the Release `.app`.

## Branding and distribution boundary

- “DeepShell Agent” and the DeepShell shell/prompt icon identify this project; they are not registered-trademark claims.
- “DeepSeek” and “DeepSeek Harness” identify the upstream project/provider. The tagline “A desktop agent powered by DeepSeek Harness.” does not claim that DeepShell Agent is an official DeepSeek product.
- Public source availability is separate from release-package distribution. Before any external binary distribution, re-run the inventory, include all license/NOTICE texts required by the shipped dependency set, and complete an independent trademark and license review.
