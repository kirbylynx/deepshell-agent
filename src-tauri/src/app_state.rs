use crate::{
    error::AppError,
    paths::AppPaths,
    sidecar::{open_logs_directory, RuntimeSnapshot, Supervisor},
    webview::WebviewPolicy,
};
use std::{path::Path, path::PathBuf, sync::Arc, thread, time::Duration};
use tauri::{AppHandle, Manager};

/// 把本应用已知的根路径替换为占位符，避免机器相关的绝对路径进入日志与诊断包。
///
/// 涉及两个根：
/// - **应用数据目录** `%APPDATA%\com.deepshell.agent`（`paths.app_data`）；
/// - **资源根**（安装目录，如 `D:\DeepShell Agent\`）——`AppPaths` 未直接保存它，
///   但 `paths.node` 恒定位于 `<resources>/runtime/node/<platform>/node.exe`，
///   故从其**祖先**反推：向上 3 层即 `<resources>`。
///
/// 替换后仍保留相对结构（如 `<RESOURCES>/runtime/node`），诊断价值不降而路径不外泄。
/// 仅在前缀**恰好以路径分隔符结束**时替换，避免把 `<RESOURCES>-other` 之类的
/// 同前缀目录误脱敏。
fn redact_roots(path: &Path, paths: &AppPaths) -> String {
    let text = path.to_string_lossy();
    let resources = resources_root(paths);
    let candidates: [(&Path, &str); 2] = match resources {
        Some(root) => [
            (paths.app_data.as_path(), "<APP_DATA>"),
            (root, "<RESOURCES>"),
        ],
        None => [
            (paths.app_data.as_path(), "<APP_DATA>"),
            (Path::new("\u{0}"), ""),
        ],
    };
    for (root, placeholder) in candidates {
        let root_text = root.to_string_lossy();
        if root_text.is_empty() || root_text == "\u{0}" {
            continue;
        }
        if let Some(rest) = text.strip_prefix(root_text.as_ref()) {
            // 必须落在分隔符边界上
            if rest.is_empty() || rest.starts_with(['\\', '/']) {
                let normalized = rest.replace('\\', "/");
                return format!("{placeholder}{normalized}");
            }
        }
    }
    text.into_owned()
}

/// 从 `paths.node` 反推资源根。
///
/// `paths.node` 的形态随平台而变（Windows `<resources>/runtime/node/win32-x64/node.exe`、
/// macOS `<resources>/runtime/node/darwin-arm64/bin/node`），**层数不同**，
/// 因此不按层数硬编码，而是定位路径中的 **`runtime` 段**，取其父目录即 `<resources>`。
fn resources_root(paths: &AppPaths) -> Option<&Path> {
    let mut current = paths.node.as_path();
    while let Some(parent) = current.parent() {
        if parent.file_name().is_some_and(|name| name == "runtime") {
            return parent.parent();
        }
        current = parent;
    }
    None
}

pub struct AppState {
    supervisor: Supervisor,
    logs: PathBuf,
}

impl AppState {
    pub fn bootstrap(
        app_data_root: PathBuf,
        resource_root: PathBuf,
        policy: Arc<WebviewPolicy>,
    ) -> Result<Self, AppError> {
        let paths = AppPaths::new(app_data_root, resource_root)?;
        // 记录解析后的关键路径：真机验收时曾出现 sidecar 以畸形路径启动
        // （node 报 `EISDIR: lstat 'D:'`），而日志里没有任何路径信息、无法定位。
        //
        // ⚠️ **必须做路径脱敏**：诊断包导出时只识别已登记的**标准用户目录前缀**
        // （`%APPDATA%` / `$HOME` 等），**安装目录**（如 `D:\DeepShell Agent\`）不在其列，
        // 因此原始绝对路径会原样进入 `app-log.redacted.jsonl`，与 `diagnostics.json`
        // 声明的 `"absolute user paths are redacted before export"` **相矛盾**
        // （真机 S12 验收实测发现）。故在**写入日志时**就把本应用已知的两个根替换为占位符，
        // 既保留诊断所需的相对结构，又不写入机器相关的绝对路径。
        let _ = crate::logging::record_detailed(
            &paths.logs,
            "info",
            "runtime_paths_resolved",
            None,
            None,
            Some(&format!(
                "node={} dshEntry={} workspace={} dshHome={}",
                redact_roots(&paths.node, &paths),
                redact_roots(&paths.dsh_entry, &paths),
                redact_roots(&paths.workspace, &paths),
                redact_roots(&paths.dsh_home, &paths)
            )),
        );
        Ok(Self {
            logs: paths.logs.clone(),
            supervisor: Supervisor::new(paths, policy),
        })
    }

    pub fn snapshot(&self) -> RuntimeSnapshot {
        self.supervisor.snapshot()
    }

    pub fn start_runtime(&self, app: &AppHandle) -> Result<(), AppError> {
        self.supervisor.start(app).map(|_| ())
    }

    pub fn restart_runtime(&self, app: &AppHandle) -> Result<(), AppError> {
        self.supervisor.restart(app).map(|_| ())
    }

    pub fn stop_runtime(&self) -> Result<(), AppError> {
        self.supervisor.stop()
    }

    /// 记录一次菜单动作到审计日志：只写稳定菜单 id，不含用户内容。
    pub fn record_menu_action(&self, menu_id: &str) {
        let _ = crate::logging::record_detailed(
            &self.logs,
            "info",
            "menu_action",
            None,
            None,
            Some(menu_id),
        );
    }

    pub fn record_failure(&self, error: &AppError, startup: bool) {
        self.supervisor.record_failure(error, startup);
    }

    pub fn open_logs_directory(&self, app: &AppHandle) -> Result<(), AppError> {
        open_logs_directory(&self.logs, app)
    }

    pub fn show_failure_window(&self, app: &AppHandle) -> Result<(), AppError> {
        self.supervisor.show_failure_window(app)
    }

    pub fn show_for_second_instance(&self, app: &AppHandle) -> Result<(), AppError> {
        self.supervisor.show_for_second_instance(app)
    }

    pub fn start_monitor(app: AppHandle) {
        if !app.state::<AppState>().supervisor.claim_monitor() {
            return;
        }
        thread::spawn(move || {
            loop {
                thread::sleep(Duration::from_millis(250));
                let state = app.state::<AppState>();
                match state.supervisor.monitor_tick(&app) {
                    Ok(true) => {}
                    Ok(false) => break,
                    Err(error) => {
                        state.record_failure(&error, false);
                        let _ = state.show_failure_window(&app);
                        break;
                    }
                }
            }
            app.state::<AppState>().supervisor.release_monitor();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一对测试用的根路径。Windows 用盘符路径，其他平台用 POSIX 路径。
    #[cfg(windows)]
    fn roots() -> (PathBuf, PathBuf, AppPaths) {
        let data = PathBuf::from(r"C:\Users\tester\AppData\Roaming\com.deepshell.agent");
        let resources = PathBuf::from(r"D:\DeepShell Agent");
        let paths = AppPaths::new(data.clone(), resources.clone()).unwrap();
        (data, resources, paths)
    }

    #[cfg(not(windows))]
    fn roots() -> (PathBuf, PathBuf, AppPaths) {
        let data = PathBuf::from("/Users/tester/Library/Application Support/com.deepshell.agent");
        let resources = PathBuf::from("/Applications/DeepShell Agent.app/Contents/Resources");
        let paths = AppPaths::new(data.clone(), resources.clone()).unwrap();
        (data, resources, paths)
    }

    /// 资源根必须能从 `node` 路径反推出来——**且不得依赖层数**：
    /// Windows 与 macOS 的 `runtime/node/<platform>/…` 层数不同。
    #[test]
    fn resources_root_is_derived_from_the_runtime_segment() {
        let (_data, resources, paths) = roots();
        assert_eq!(resources_root(&paths), Some(resources.as_path()));
    }

    /// 两个已知根都必须被替换为占位符：诊断包导出时**只识别标准用户目录前缀**，
    /// 安装目录不在其列，若不在此处脱敏就会原样进入 `app-log.redacted.jsonl`
    /// （真机 S12 验收实测发现，与 `diagnostics.json` 的 pathPolicy 声明矛盾）。
    #[test]
    fn redacts_both_app_data_and_resources_roots() {
        let (_data, resources, paths) = roots();
        let node = redact_roots(&paths.node, &paths);
        let workspace = redact_roots(&paths.workspace, &paths);

        assert!(node.starts_with("<RESOURCES>/"), "实际为 {node}");
        assert!(node.contains("/runtime/node/"), "实际为 {node}");
        assert!(workspace.starts_with("<APP_DATA>/"), "实际为 {workspace}");

        // 不得残留任一绝对根
        for text in [&node, &workspace] {
            assert!(
                !text.contains(&*resources.to_string_lossy()),
                "泄漏资源根：{text}"
            );
            assert!(
                !text.contains(&*paths.app_data.to_string_lossy()),
                "泄漏数据目录：{text}"
            );
        }
    }

    /// **不得过度脱敏**：与根同前缀但不以分隔符结尾的兄弟目录必须原样保留，
    /// 否则会把 `D:\DeepShell Agent-other` 误判为安装目录。
    #[test]
    fn does_not_redact_sibling_directory_with_shared_prefix() {
        let (_data, resources, paths) = roots();
        let sibling = resources.parent().unwrap().join(format!(
            "{}-other",
            resources.file_name().unwrap().to_string_lossy()
        ));
        let text = redact_roots(&sibling.join("file.txt"), &paths);
        assert!(!text.starts_with("<RESOURCES>"), "过度脱敏：{text}");
        assert!(text.contains("-other"), "实际为 {text}");
    }

    /// **不得泄露系统目录**：既不属于数据目录也不属于资源根的路径（如 `System32`）
    /// 当前仍会原样保留。这是**已知边界**，须与需求 §10.6 对 S12 的判定口径一致——
    /// 因此该断言锁定的是"不得自称已脱敏"，而不是"必须脱敏"。
    #[test]
    fn documents_known_boundary_for_unrelated_absolute_paths() {
        let (_data, _resources, paths) = roots();
        #[cfg(windows)]
        let unrelated = PathBuf::from(r"C:\Windows\System32\taskkill.exe");
        #[cfg(not(windows))]
        let unrelated = PathBuf::from("/usr/bin/open");

        let text = redact_roots(&unrelated, &paths);
        assert_eq!(
            text,
            unrelated.to_string_lossy(),
            "与两个已知根无关的路径不在脱敏范围内"
        );
    }
}
