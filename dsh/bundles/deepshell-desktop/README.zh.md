语言：[English](README.md) | 简体中文

# DeepShell Desktop Integration Bundle

该 Bundle 是 `v0.1.0` MVP 的 DSH Web Profile 扩展层，遵循官方 `dsh.bundle` 与 `dsh.client` 契约：

- Host 入口注入官方 Web UI 所需 CSP，并提供与 Sidecar 实例绑定的 Ready 路由；
- Client 入口通过官方 `window.__ModuleLoader__.load` 加载 React/UI 模块，注册产品名与 DeepShell 扇贝图标；
- Patch 禁用遥测，并把默认 Agent Preset 设为 `deepshell-coding`；
- Web Search、Web Fetch 与 `tool-web` 保持官方启用状态，由官方 DSH runtime 提供。

`deepshell-coding` 与 `deepshell-work` Preset 不在此目录手写。`scripts/prepare-profile.mjs` 从锁定版本官方 `standard` Preset 机械派生，权限继续复用官方 `workspace-write` Permission Preset。

实现不 fork 或修改官方 Web UI，不导入 DSH 私有路径，也不做 DOM monkey patch。
