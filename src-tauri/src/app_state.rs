use crate::{
    error::AppError,
    paths::AppPaths,
    sidecar::{open_logs_directory, RuntimeSnapshot, Supervisor},
    webview::WebviewPolicy,
};
use std::{path::PathBuf, sync::Arc, thread, time::Duration};
use tauri::{AppHandle, Manager};

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
        // 这些路径由本应用按固定规则拼接、不含凭据，可安全记录。
        let _ = crate::logging::record_detailed(
            &paths.logs,
            "info",
            "runtime_paths_resolved",
            None,
            None,
            Some(&format!(
                "node={} dshEntry={} workspace={} dshHome={}",
                paths.node.display(),
                paths.dsh_entry.display(),
                paths.workspace.display(),
                paths.dsh_home.display()
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
