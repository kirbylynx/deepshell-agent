Language: English | [简体中文](README.zh.md)

# DeepShell POC Integration Bundle

This bundle extends the official `web` Profile through DSH's public `dsh.bundle` and `dsh.client` contracts:

- The Host entry injects the CSP required by the official Web UI and exposes a Ready route bound to the Sidecar instance.
- The Client entry loads React/UI modules through the official `window.__ModuleLoader__.load` mechanism and registers the product name plus the DeepShell scallop icon.
- The Patch disables Web Search, Web Fetch, and telemetry, and sets the default Agent Preset to `deepshell`.

The `deepshell` preset is not handwritten in this directory. `scripts/prepare-profile.mjs` mechanically derives it from the locked official `standard` preset and only removes the top-level `tool-web` plugin. The official `workspace-write` Permission Preset remains unchanged.

This implementation does not fork or modify the official Web UI, does not import private DSH paths, and does not use DOM monkey patching.
