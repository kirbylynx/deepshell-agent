Language: English | [简体中文](README.zh.md)

# DeepShell Desktop Integration Bundle

This bundle is the DSH Web Profile extension layer for the `v0.1.0` MVP. It follows the official `dsh.bundle` and `dsh.client` contracts:

- The Host entry injects the CSP required by the official Web UI and exposes a Ready route bound to the Sidecar instance.
- The Client entry loads React/UI modules through the official `window.__ModuleLoader__.load` mechanism and registers the product name plus the DeepShell scallop icon.
- The Patch disables telemetry and sets the default Agent Preset to `deepshell-coding`.
- Web Search, Web Fetch, and `tool-web` remain enabled through the official DSH runtime.

The `deepshell-coding` and `deepshell-work` presets are not handwritten in this directory. `scripts/prepare-profile.mjs` mechanically derives them from the locked official `standard` preset, while permissions continue to reuse the official `workspace-write` Permission Preset.

This implementation does not fork or modify the official Web UI, does not import private DSH paths, and does not use DOM monkey patching.
