语言：[English](README.md) | 简体中文

# DeepShell POC Integration Bundle

该 Bundle 通过 DSH 的公开 `dsh.bundle` 与 `dsh.client` 契约扩展官方 `web` Profile：

- Host 入口注入官方 Web UI 所需 CSP，并提供与 Sidecar 实例绑定的 Ready 路由；
- Client 入口通过官方 `window.__ModuleLoader__.load` 加载 React/UI 模块，注册产品名与 DeepShell 扇贝图标；
- Patch 禁用 Web Search、Web Fetch 和遥测，并把默认 Agent Preset 设为 `deepshell`。

`deepshell` Preset 不在此目录手写。`scripts/prepare-profile.mjs` 从锁定版本官方 `standard` 机械派生，只移除顶层 `tool-web` 插件；官方 `workspace-write` Permission Preset 保持原样。

实现不 fork 或修改官方 Web UI，不导入 DSH 私有路径，也不做 DOM monkey patch。
