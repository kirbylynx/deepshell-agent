use super::{command, handshake, process_tree};
use crate::{
    error::{AppError, ErrorCode},
    logging,
    paths::AppPaths,
    webview::WebviewPolicy,
};
use serde::Serialize;
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    net::{Ipv4Addr, SocketAddrV4, TcpStream},
    path::{Path, PathBuf},
    process::Child,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::Manager;
use url::Url;
use uuid::Uuid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimePhase {
    Starting,
    Ready,
    Recovering,
    StartupFailed,
    RuntimeFailed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub phase: RuntimePhase,
    pub status: String,
    pub sidecar_pid: Option<u32>,
    pub authority: Option<String>,
    pub token_state: String,
    pub error_code: Option<String>,
}

impl RuntimeSnapshot {
    fn starting() -> Self {
        Self {
            phase: RuntimePhase::Starting,
            status: "准备启动中…".into(),
            sidecar_pid: None,
            authority: None,
            token_state: "process_scoped_hidden".into(),
            error_code: None,
        }
    }
}

struct ActiveRuntime {
    child: Child,
    instance_id: String,
    ready_since: Instant,
    registry_refreshed_at: Instant,
}

pub struct Supervisor {
    paths: AppPaths,
    policy: Arc<WebviewPolicy>,
    active: Mutex<Option<ActiveRuntime>>,
    lifecycle: Mutex<()>,
    snapshot: Mutex<RuntimeSnapshot>,
    crash_window: Mutex<Option<Instant>>,
    shutdown_intent: AtomicBool,
    shutdown_generation: AtomicU64,
    shutdown_deadline: Mutex<Option<Instant>>,
    monitor_running: AtomicBool,
}

impl Supervisor {
    pub fn new(paths: AppPaths, policy: Arc<WebviewPolicy>) -> Self {
        Self {
            paths,
            policy,
            active: Mutex::new(None),
            lifecycle: Mutex::new(()),
            snapshot: Mutex::new(RuntimeSnapshot::starting()),
            crash_window: Mutex::new(None),
            shutdown_intent: AtomicBool::new(false),
            shutdown_generation: AtomicU64::new(0),
            shutdown_deadline: Mutex::new(None),
            monitor_running: AtomicBool::new(false),
        }
    }

    pub fn snapshot(&self) -> RuntimeSnapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub fn record_failure(&self, error: &AppError, startup: bool) {
        let phase = failure_phase(error, startup);
        let token_state = failure_token_state(error, startup);
        // 把失败原因的文字说明一并写入日志。此前只记 `errorCode`，导致现场只剩
        // `runtime_start_failed` 一个代号、无法定位（本机 Windows 验收实测暴露）。
        // 该文本全部由本应用构造，且经 logging 层的最小脱敏，不含凭据。
        let _ = logging::record_detailed(
            &self.paths.logs,
            "error",
            if phase == RuntimePhase::StartupFailed {
                "startup_failed"
            } else {
                "runtime_failed"
            },
            Some(error.code()),
            None,
            Some(error.user_message()),
        );
        *self
            .snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = RuntimeSnapshot {
            phase,
            status: error.user_message().to_owned(),
            sidecar_pid: None,
            authority: None,
            token_state: token_state.into(),
            error_code: Some(error.code().to_string()),
        };
    }

    pub fn start(&self, app: &tauri::AppHandle) -> Result<RuntimeSnapshot, AppError> {
        let _operation = self
            .lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.start_locked(app)
    }

    fn start_locked(&self, app: &tauri::AppHandle) -> Result<RuntimeSnapshot, AppError> {
        if self.shutdown_intent.load(Ordering::SeqCst) {
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "退出请求已取消 Runtime 启动",
            ));
        }
        *self
            .snapshot
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = RuntimeSnapshot::starting();
        self.paths.prepare()?;
        process_tree::recover_registered(
            &self.paths.ownership_file,
            &self.paths.node,
            Instant::now() + Duration::from_secs(5),
            Some(&self.shutdown_intent),
        )?;
        if self.shutdown_intent.load(Ordering::SeqCst) {
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "退出请求已取消 Runtime 启动",
            ));
        }
        let instance_id = Uuid::new_v4().to_string();
        let _ = logging::record_with_instance(
            &self.paths.logs,
            "info",
            "runtime_starting",
            None,
            Some(&instance_id),
        );
        let mut child = command::build(&self.paths, &instance_id)?
            .spawn()
            .map_err(|error| {
                AppError::new(
                    ErrorCode::RuntimeStartFailed,
                    format!("无法启动 DSH：{error}"),
                )
            })?;
        let pid = child.id();
        // sidecar 的 stderr 此前被**整段丢弃**，导致启动失败时现场没有任何线索
        // （本机 Windows 验收实测：日志只剩 `runtime_start_failed` 一个代号）。
        // 在 `try_wait` 之前就开始持续读取并保留尾部，供失败时落盘诊断。
        let stderr_tail = child.stderr.take().map(capture_stderr_tail);
        if let Err(registration_error) = process_tree::register(
            &self.paths.ownership_file,
            pid,
            &self.paths.node,
            &instance_id,
        ) {
            let deadline = self.effective_cleanup_deadline();
            return match process_tree::terminate_unregistered_spawn(
                &self.paths.ownership_file,
                &mut child,
                pid,
                &self.paths.node,
                &instance_id,
                deadline,
            ) {
                Ok(()) => Err(registration_error),
                Err(cleanup_error) => Err(AppError::new(
                    ErrorCode::RuntimeStopFailed,
                    format!(
                        "ownership registry 建立失败（{registration_error}），且故障清理失败（{cleanup_error}）"
                    ),
                )),
            };
        }
        let result = self.complete_start(app, &mut child, &instance_id, pid);
        match result {
            Ok(snapshot) => {
                *self
                    .active
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(ActiveRuntime {
                    child,
                    instance_id: instance_id.clone(),
                    ready_since: Instant::now(),
                    registry_refreshed_at: Instant::now(),
                });
                *self
                    .snapshot
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner()) = snapshot.clone();
                let _ = logging::record_with_instance(
                    &self.paths.logs,
                    "info",
                    "runtime_ready",
                    None,
                    Some(&instance_id),
                );
                if let Err(error) = self.show_ready_window(app) {
                    let _ = self.stop_locked(self.effective_cleanup_deadline());
                    return Err(error);
                }
                Ok(snapshot)
            }
            Err(error) => {
                // 先把 sidecar 的 stderr 尾部落盘，再走清理流程——否则子进程被终止后
                // 现场就再也取不到了（这正是此前无法定位 `runtime_start_failed` 的原因）。
                if let Some(tail) = stderr_tail.as_ref() {
                    write_sidecar_stderr_diagnostic(&self.paths.logs, tail);
                }
                self.policy.clear_dsh_origin();
                let deadline = self.effective_cleanup_deadline();
                let cleanup_result = process_tree::begin_cleanup(&self.paths.ownership_file)
                    .or_else(|_| {
                        process_tree::retry_cleanup(&self.paths.ownership_file, &self.paths.node)
                    })
                    .and_then(|_| {
                        process_tree::terminate_registered(
                            &self.paths.ownership_file,
                            Some(&mut child),
                            deadline,
                            None,
                        )
                    })
                    .and_then(|_| process_tree::unregister(&self.paths.ownership_file));
                if cleanup_result.is_err() {
                    let _ = process_tree::quarantine_registered(&self.paths.ownership_file);
                }
                failed_start_result(error, cleanup_result)
            }
        }
    }

    fn complete_start(
        &self,
        app: &tauri::AppHandle,
        child: &mut Child,
        instance_id: &str,
        pid: u32,
    ) -> Result<RuntimeSnapshot, AppError> {
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::new(ErrorCode::RuntimeStartFailed, "DSH stdout 不可用"))?;
        let receiver = parse_stdout(stdout, self.paths.logs.clone());
        let auth_deadline = Instant::now() + Duration::from_secs(90);
        let auth = loop {
            if self.shutdown_intent.load(Ordering::SeqCst) {
                return Err(AppError::new(
                    ErrorCode::RuntimeStopFailed,
                    "启动已被退出请求取消",
                ));
            }
            if let Some(status) = child.try_wait().map_err(|error| {
                AppError::new(
                    ErrorCode::RuntimeStartFailed,
                    format!("无法检查 DSH：{error}"),
                )
            })? {
                return Err(AppError::new(
                    ErrorCode::RuntimeStartFailed,
                    format!("DSH 在提供连接 URL 前退出（{status}）"),
                ));
            }
            let remaining = auth_deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(AppError::new(
                    ErrorCode::RuntimeStartFailed,
                    "等待 DSH URL 超时",
                ));
            }
            match receiver.recv_timeout(remaining.min(Duration::from_millis(100))) {
                Ok(result) => break result?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(AppError::new(
                        ErrorCode::RuntimeStartFailed,
                        "DSH 未提供有效连接 URL",
                    ));
                }
            }
        };
        let port = auth.port();
        wait_for_listener(port, &self.shutdown_intent)?;
        let secret_url = auth.expose()?;
        self.policy.set_dsh_origin(&secret_url)?;
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| AppError::new(ErrorCode::RuntimeUnavailable, "主窗口不存在"))?;
        window
            .navigate(secret_url)
            .map_err(|error| AppError::new(ErrorCode::NavigationBlocked, error.to_string()))?;

        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(60) {
            if self.shutdown_intent.load(Ordering::SeqCst) {
                return Err(AppError::new(
                    ErrorCode::RuntimeStopFailed,
                    "启动已被退出请求取消",
                ));
            }
            if child
                .try_wait()
                .map_err(|error| {
                    AppError::new(
                        ErrorCode::RuntimeStartFailed,
                        format!("无法检查 DSH：{error}"),
                    )
                })?
                .is_some()
            {
                return Err(AppError::new(
                    ErrorCode::RuntimeStartFailed,
                    "DSH 在 Client Ready 前退出",
                ));
            }
            if handshake::ready_file(&self.paths.ready_file, instance_id, pid, port)? {
                let clean_url = Url::parse(&format!("http://127.0.0.1:{port}/"))
                    .map_err(|_| AppError::new(ErrorCode::HandshakeInvalid, "Clean URL 无效"))?;
                let current_url = window.url().map_err(|error| {
                    AppError::new(ErrorCode::NavigationBlocked, error.to_string())
                })?;
                if !self.policy.is_clean_dsh_page(&current_url) {
                    window.navigate(clean_url).map_err(|error| {
                        AppError::new(ErrorCode::NavigationBlocked, error.to_string())
                    })?;
                }
                return Ok(RuntimeSnapshot {
                    phase: RuntimePhase::Ready,
                    status: "Runtime 已就绪".into(),
                    sidecar_pid: Some(pid),
                    authority: Some(format!("127.0.0.1:{port}")),
                    token_state: "process_scoped_hidden".into(),
                    error_code: None,
                });
            }
            thread::sleep(Duration::from_millis(50));
        }
        Err(AppError::new(
            ErrorCode::RuntimeStartFailed,
            "等待 Client baseline Ready 超时",
        ))
    }

    pub fn restart(&self, app: &tauri::AppHandle) -> Result<RuntimeSnapshot, AppError> {
        let shutdown_generation = self.shutdown_generation.load(Ordering::SeqCst);
        let _operation = self
            .lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !restart_allowed(
            shutdown_generation,
            self.shutdown_generation.load(Ordering::SeqCst),
            self.shutdown_intent.load(Ordering::SeqCst),
        ) {
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "退出请求优先于 Runtime 重启",
            ));
        }
        self.stop_locked(Instant::now() + Duration::from_secs(5))?;
        if !restart_allowed(
            shutdown_generation,
            self.shutdown_generation.load(Ordering::SeqCst),
            self.shutdown_intent.load(Ordering::SeqCst),
        ) {
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "退出请求优先于 Runtime 重启",
            ));
        }
        *self
            .crash_window
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        {
            let mut snapshot = self
                .snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            snapshot.phase = RuntimePhase::Recovering;
            snapshot.status = "Runtime 重启中…".into();
            snapshot.error_code = None;
        }
        self.show_bootstrap_window(app)?;
        self.start_locked(app)
    }

    pub fn stop(&self) -> Result<(), AppError> {
        let deadline = Instant::now() + Duration::from_secs(5);
        *self
            .shutdown_deadline
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(deadline);
        self.shutdown_generation.fetch_add(1, Ordering::SeqCst);
        self.shutdown_intent.store(true, Ordering::SeqCst);
        let _operation = self
            .lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let result = self.stop_locked(deadline);
        *self
            .shutdown_deadline
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        if result.is_err() {
            self.shutdown_intent.store(false, Ordering::SeqCst);
        }
        result
    }

    fn stop_locked(&self, deadline: Instant) -> Result<(), AppError> {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(runtime) = active.as_mut() {
            let _ = logging::record_with_instance(
                &self.paths.logs,
                "info",
                "runtime_stopping",
                None,
                Some(&runtime.instance_id),
            );
            let prepared = process_tree::refresh_registered(&self.paths.ownership_file)
                .and_then(|_| process_tree::begin_cleanup(&self.paths.ownership_file))
                .or_else(|_| {
                    process_tree::retry_cleanup(&self.paths.ownership_file, &self.paths.node)
                });
            if let Err(error) = prepared {
                let _ = process_tree::quarantine_registered(&self.paths.ownership_file);
                return Err(error);
            }
            if let Err(error) = process_tree::terminate_registered(
                &self.paths.ownership_file,
                Some(&mut runtime.child),
                deadline,
                None,
            ) {
                let _ = process_tree::quarantine_registered(&self.paths.ownership_file);
                return Err(error);
            }
            if let Err(error) = process_tree::unregister(&self.paths.ownership_file) {
                let _ = process_tree::quarantine_registered(&self.paths.ownership_file);
                return Err(error);
            }
            let _ = logging::record_with_instance(
                &self.paths.logs,
                "info",
                "runtime_stopped",
                None,
                Some(&runtime.instance_id),
            );
            active.take();
        } else {
            process_tree::recover_registered(
                &self.paths.ownership_file,
                &self.paths.node,
                deadline,
                None,
            )?;
        }
        self.policy.clear_dsh_origin();
        Ok(())
    }

    fn effective_cleanup_deadline(&self) -> Instant {
        self.shutdown_deadline
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .filter(|_| self.shutdown_intent.load(Ordering::SeqCst))
            .unwrap_or_else(|| Instant::now() + Duration::from_secs(5))
    }

    pub fn claim_monitor(&self) -> bool {
        !self.monitor_running.swap(true, Ordering::SeqCst)
    }

    pub fn release_monitor(&self) {
        self.monitor_running.store(false, Ordering::SeqCst);
    }

    pub fn monitor_tick(&self, app: &tauri::AppHandle) -> Result<bool, AppError> {
        if self.shutdown_intent.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let _operation = self
            .lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if self.shutdown_intent.load(Ordering::SeqCst) {
            return Ok(false);
        }
        let crashed = {
            let mut guard = self
                .active
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(active) = guard.as_mut() else {
                return Ok(false);
            };
            match active.child.try_wait().map_err(|error| {
                AppError::new(
                    ErrorCode::RuntimeStopFailed,
                    format!("无法监测 DSH：{error}"),
                )
            })? {
                Some(_) => guard.take(),
                None => {
                    if active.registry_refreshed_at.elapsed() >= Duration::from_millis(250) {
                        process_tree::refresh_registered(&self.paths.ownership_file)?;
                        active.registry_refreshed_at = Instant::now();
                    }
                    if active.ready_since.elapsed() >= Duration::from_secs(60) {
                        *self
                            .crash_window
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
                    }
                    return Ok(true);
                }
            }
        };
        let Some(crashed) = crashed else {
            return Ok(true);
        };
        let _ = logging::record_with_instance(
            &self.paths.logs,
            "error",
            "runtime_crashed",
            None,
            Some(&crashed.instance_id),
        );
        process_tree::recover_registered(
            &self.paths.ownership_file,
            &self.paths.node,
            Instant::now() + Duration::from_secs(5),
            Some(&self.shutdown_intent),
        )?;
        self.show_bootstrap_window(app)?;
        if self.shutdown_intent.load(Ordering::SeqCst) {
            return Ok(false);
        }

        let now = Instant::now();
        let allow_restart = {
            let mut window = self
                .crash_window
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            consume_restart_budget(&mut window, now)
        };
        if !allow_restart {
            return Err(AppError::new(
                ErrorCode::RuntimeStartFailed,
                "DSH 在 60 秒窗口内第二次崩溃，已停止自动重启",
            ));
        }
        {
            let mut snapshot = self
                .snapshot
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            snapshot.phase = RuntimePhase::Recovering;
            snapshot.status = "检测到 DSH 异常退出，正在清理并自动恢复…".into();
            snapshot.sidecar_pid = None;
            snapshot.authority = None;
        }
        self.start_locked(app)?;
        Ok(true)
    }

    fn show_bootstrap_window(&self, app: &tauri::AppHandle) -> Result<(), AppError> {
        self.policy.clear_dsh_origin();
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| AppError::new(ErrorCode::RuntimeUnavailable, "主窗口不存在"))?;
        let url = bootstrap_url()
            .map_err(|error| AppError::new(ErrorCode::RuntimeUnavailable, error.to_string()))?;
        window
            .navigate(url)
            .map_err(|error| AppError::new(ErrorCode::NavigationBlocked, error.to_string()))?;
        window
            .show()
            .map_err(|error| AppError::new(ErrorCode::RuntimeUnavailable, error.to_string()))?;
        Ok(())
    }

    pub fn show_failure_window(&self, app: &tauri::AppHandle) -> Result<(), AppError> {
        self.show_bootstrap_window(app)
    }

    pub fn show_for_second_instance(&self, app: &tauri::AppHandle) -> Result<(), AppError> {
        match second_instance_visibility(self.snapshot().phase) {
            SecondInstanceVisibility::DeferUntilReady => Ok(()),
            SecondInstanceVisibility::ShowBootstrap => self.show_bootstrap_window(app),
            SecondInstanceVisibility::ShowCurrent => {
                let window = app
                    .get_webview_window("main")
                    .ok_or_else(|| AppError::new(ErrorCode::RuntimeUnavailable, "主窗口不存在"))?;
                window.show().map_err(|error| {
                    AppError::new(ErrorCode::RuntimeUnavailable, error.to_string())
                })?;
                window.set_focus().ok();
                Ok(())
            }
        }
    }

    fn show_ready_window(&self, app: &tauri::AppHandle) -> Result<(), AppError> {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| AppError::new(ErrorCode::RuntimeUnavailable, "主窗口不存在"))?;
        window
            .eval("document.documentElement.dataset.deepshellRuntimeReady='true'")
            .map_err(|error| AppError::new(ErrorCode::RuntimeUnavailable, error.to_string()))?;
        window
            .show()
            .map_err(|error| AppError::new(ErrorCode::RuntimeUnavailable, error.to_string()))?;
        window.set_focus().ok();
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SecondInstanceVisibility {
    DeferUntilReady,
    ShowBootstrap,
    ShowCurrent,
}

fn second_instance_visibility(phase: RuntimePhase) -> SecondInstanceVisibility {
    match phase {
        RuntimePhase::Starting | RuntimePhase::Recovering => {
            SecondInstanceVisibility::DeferUntilReady
        }
        RuntimePhase::StartupFailed | RuntimePhase::RuntimeFailed => {
            SecondInstanceVisibility::ShowBootstrap
        }
        RuntimePhase::Ready => SecondInstanceVisibility::ShowCurrent,
    }
}

fn wait_for_listener(port: u16, shutdown_intent: &AtomicBool) -> Result<(), AppError> {
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(5) {
        if shutdown_intent.load(Ordering::SeqCst) {
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "启动已被退出请求取消",
            ));
        }
        if TcpStream::connect_timeout(&address.into(), Duration::from_millis(250)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(AppError::new(
        ErrorCode::RuntimeStartFailed,
        "DSH listener 不可连接",
    ))
}

fn parse_stdout(
    reader: impl Read + Send + 'static,
    logs: PathBuf,
) -> mpsc::Receiver<Result<handshake::AuthUrl, AppError>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut delivered = false;
        // 记录 sidecar stdout 的**首行**原文：真机验收时出现过 sidecar 存活但应用始终
        // 收不到 URL 的情况，而日志里看不到 sidecar 究竟输出了什么。
        // 首行是 `dsh web: <url>`，其中的 token 在写入前会被抹掉。
        let mut first_line: Option<String> = None;
        for line in BufReader::new(reader).lines() {
            let outcome = line
                .map_err(|error| AppError::new(ErrorCode::HandshakeInvalid, error.to_string()))
                .and_then(|line| {
                    if first_line.is_none() && !line.trim().is_empty() {
                        first_line = Some(line.clone());
                    }
                    handshake::parse(&line)
                });
            match outcome {
                Ok(Some(auth)) => {
                    write_sidecar_stdout_probe(&logs, first_line.as_deref());
                    if !delivered {
                        delivered = sender.send(Ok(auth)).is_ok();
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    write_sidecar_stdout_probe(&logs, first_line.as_deref());
                    if !delivered {
                        let _ = sender.send(Err(error));
                        return;
                    }
                }
            }
        }
        // 流结束仍未交付 → 把首行留下，供判断"是否根本没打印 URL"
        if !delivered {
            write_sidecar_stdout_probe(&logs, first_line.as_deref());
        }
    });
    receiver
}

/// 把 sidecar stdout 的首行（脱敏 token 后）写入诊断文件。
fn write_sidecar_stdout_probe(logs: &Path, first_line: Option<&str>) {
    let Some(line) = first_line else { return };
    let redacted = match line.split_once("token=") {
        Some((prefix, _)) => format!("{prefix}token=[redacted]"),
        None => line.to_owned(),
    };
    if fs::create_dir_all(logs).is_err() {
        return;
    }
    let _ = fs::write(logs.join("sidecar-stdout-first-line.log"), redacted);
}

/// 持续读取 sidecar 的 stderr，并在内存中只保留**尾部**若干字节。
///
/// 保留尾部而非全部：崩溃/报错的真正原因通常在最后几行，而 DSH 在启动阶段会输出较多进度信息。
/// 读取必须持续进行，否则管道写满会阻塞 sidecar。
fn capture_stderr_tail(mut reader: impl Read + Send + 'static) -> Arc<Mutex<Vec<u8>>> {
    const TAIL_LIMIT: usize = 16 * 1024;
    let tail = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&tail);
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        while let Ok(read) = reader.read(&mut buffer) {
            if read == 0 {
                break;
            }
            if let Ok(mut held) = sink.lock() {
                held.extend_from_slice(&buffer[..read]);
                if held.len() > TAIL_LIMIT {
                    let excess = held.len() - TAIL_LIMIT;
                    held.drain(..excess);
                }
            }
        }
    });
    tail
}

/// 启动失败时把 sidecar 的 stderr 尾部落盘到独立文件，供人工排查。
///
/// 直接落盘而不写入 `app.jsonl`：stderr 内容不可控，且可能包含路径等信息；
/// 独立文件既便于查看，也避免污染结构化审计日志。
/// 文件名固定，每次失败覆盖，因此不会无限增长。
fn write_sidecar_stderr_diagnostic(logs: &Path, tail: &Arc<Mutex<Vec<u8>>>) {
    let Ok(held) = tail.lock() else { return };
    if held.is_empty() {
        return;
    }
    if fs::create_dir_all(logs).is_err() {
        return;
    }
    let _ = fs::write(logs.join("sidecar-stderr.log"), &*held);
}

/// 应用自身 bootstrap 页面的 URL。
///
/// ⚠️ **平台差异**（与 Tauri 2 的 `Manager::tauri_protocol_url` 一致，该函数为
/// `pub(crate)` 无法直接调用）：
/// - **Windows / Android**：`wry` 的 workaround 形式 `http://tauri.localhost`；
/// - macOS / iOS：自定义协议 `tauri://localhost`。
///
/// 早期实现硬编码 `tauri://localhost/index.html`，于是 **Windows 上的失败/引导窗口
/// 指向一个不存在的协议**，既无法导航、又会被导航策略判为外链
/// （真机验收实测暴露，与 `webview::is_app_origin` 是同一处平台差异）。
fn bootstrap_url() -> Result<Url, url::ParseError> {
    if cfg!(any(windows, target_os = "android")) {
        Url::parse("http://tauri.localhost/index.html")
    } else {
        Url::parse("tauri://localhost/index.html")
    }
}

fn consume_restart_budget(window: &mut Option<Instant>, now: Instant) -> bool {
    match *window {
        Some(first) if now.duration_since(first) < Duration::from_secs(60) => false,
        _ => {
            *window = Some(now);
            true
        }
    }
}

fn restart_allowed(captured_generation: u64, current_generation: u64, shutting_down: bool) -> bool {
    !shutting_down && captured_generation == current_generation
}

fn failed_start_result(
    startup_error: AppError,
    cleanup_result: Result<(), AppError>,
) -> Result<RuntimeSnapshot, AppError> {
    match cleanup_result {
        Ok(()) => Err(startup_error),
        Err(cleanup_error) => Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            format!("Runtime 启动失败（{startup_error}），且启动失败清理未完成（{cleanup_error}）"),
        )),
    }
}

fn failure_phase(error: &AppError, startup: bool) -> RuntimePhase {
    if startup && error.code() != ErrorCode::RuntimeStopFailed {
        RuntimePhase::StartupFailed
    } else {
        RuntimePhase::RuntimeFailed
    }
}

fn failure_token_state(error: &AppError, startup: bool) -> &'static str {
    if error.code() == ErrorCode::RuntimeStopFailed {
        // 清理失败时 Host/token 可能仍存活；只报告被隐藏和隔离，不能宣称已销毁。
        "quarantined_hidden"
    } else if startup {
        // failed_start_result 只有在故障清理已确认完成后才保留原启动错误。
        "destroyed"
    } else {
        // 运行期监控错误不等于已证明 Host 退出，使用保守的不确定状态。
        "unavailable_hidden"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_budget_rejects_second_crash_before_sixty_seconds() {
        let first = Instant::now();
        let mut window = None;
        assert!(consume_restart_budget(&mut window, first));
        assert!(!consume_restart_budget(
            &mut window,
            first + Duration::from_millis(59_999)
        ));
    }

    #[test]
    fn restart_budget_resets_at_sixty_seconds() {
        let first = Instant::now();
        let mut window = Some(first);
        let next = first + Duration::from_secs(60);
        assert!(consume_restart_budget(&mut window, next));
        assert_eq!(window, Some(next));
    }

    #[test]
    fn quit_always_wins_over_a_waiting_restart() {
        assert!(!restart_allowed(4, 5, true));
        assert!(!restart_allowed(5, 5, true));
        assert!(restart_allowed(5, 5, false));
    }

    #[test]
    fn second_instance_never_exposes_pending_dsh_page() {
        assert_eq!(
            second_instance_visibility(RuntimePhase::Starting),
            SecondInstanceVisibility::DeferUntilReady
        );
        assert_eq!(
            second_instance_visibility(RuntimePhase::Recovering),
            SecondInstanceVisibility::DeferUntilReady
        );
        assert_eq!(
            second_instance_visibility(RuntimePhase::Ready),
            SecondInstanceVisibility::ShowCurrent
        );
        assert_eq!(
            second_instance_visibility(RuntimePhase::StartupFailed),
            SecondInstanceVisibility::ShowBootstrap
        );
    }

    #[test]
    fn failed_start_cleanup_error_wins_and_is_runtime_failed() {
        let startup = AppError::new(ErrorCode::HandshakeInvalid, "injected handshake failure");
        let cleanup = AppError::new(ErrorCode::RuntimeStopFailed, "injected cleanup failure");
        let error = failed_start_result(startup, Err(cleanup)).unwrap_err();

        assert_eq!(error.code(), ErrorCode::RuntimeStopFailed);
        assert_eq!(failure_phase(&error, true), RuntimePhase::RuntimeFailed);
    }

    #[test]
    fn clean_failed_start_keeps_original_startup_classification() {
        let startup = AppError::new(ErrorCode::HandshakeInvalid, "injected handshake failure");
        let error = failed_start_result(startup, Ok(())).unwrap_err();

        assert_eq!(error.code(), ErrorCode::HandshakeInvalid);
        assert_eq!(failure_phase(&error, true), RuntimePhase::StartupFailed);
        assert_eq!(failure_token_state(&error, true), "destroyed");
    }

    #[test]
    fn cleanup_failure_never_claims_process_scoped_token_is_destroyed() {
        let error = AppError::new(ErrorCode::RuntimeStopFailed, "injected cleanup failure");

        assert_eq!(failure_token_state(&error, true), "quarantined_hidden");
        assert_eq!(failure_token_state(&error, false), "quarantined_hidden");
    }
}
