use crate::error::{AppError, ErrorCode};
use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;

/// `CreateProcess` 标志：不给子进程分配可见的控制台窗口。
///
/// 本应用是 **GUI 子系统**（`windows_subsystem = "windows"`，自身没有控制台），
/// 而 `taskkill` / `powershell.exe` 都是**控制台程序**。按 Windows 语义，
/// 无控制台的父进程启动控制台子进程时系统会**新建一个可见的控制台窗口**；
/// 由于这些子进程的 stdout/stderr 已被管道或 `output()` 接管，窗口内空无一物
/// —— 用户看到的就是"启动时冒出一个什么都不显示的命令行窗口"
/// （真机验收实测暴露；sidecar 本身已由 `sidecar::command` 单独设置该标志）。
///
/// 这些调用全部是**无界面的后台工具**，因此统一隐藏。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 构造一个**不显示控制台窗口**的命令。
fn console_command(program: &str) -> Command {
    let mut command = Command::new(program);
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RegistryState {
    Active,
    Cleaning,
    Quarantined,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnershipRegistry {
    schema_version: u32,
    instance_id: String,
    ownership_token: String,
    generation: u64,
    state: RegistryState,
    leader_pid: u32,
    expected_executable: PathBuf,
}

pub fn register(
    path: &Path,
    pid: u32,
    expected_executable: &Path,
    instance_id: &str,
) -> Result<(), AppError> {
    let expected = fs::canonicalize(expected_executable).map_err(runtime_stop_error)?;
    verify_executable_if_available(pid, &expected)?;
    write_registry(
        path,
        &OwnershipRegistry {
            schema_version: 1,
            instance_id: instance_id.to_owned(),
            ownership_token: uuid::Uuid::new_v4().to_string(),
            generation: 1,
            state: RegistryState::Active,
            leader_pid: pid,
            expected_executable: expected,
        },
        ErrorCode::RuntimeStartFailed,
    )
}

pub fn terminate_unregistered_spawn(
    path: &Path,
    child: &mut Child,
    pid: u32,
    expected_executable: &Path,
    instance_id: &str,
    deadline: Instant,
) -> Result<(), AppError> {
    if child.id() != pid {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "注册失败清理收到的 Child handle 与 leader PID 不一致",
        ));
    }
    let _ = register(path, pid, expected_executable, instance_id);
    let cleanup = terminate_pid_tree(pid, Some(child), deadline, None);
    let _ = unregister(path);
    cleanup
}

pub fn recover_registered(
    path: &Path,
    expected_executable: &Path,
    deadline: Instant,
    abort_on_shutdown: Option<&AtomicBool>,
) -> Result<(), AppError> {
    let Some(mut record) = read_registry(path)? else {
        return Ok(());
    };
    ensure_supported(&record)?;
    let expected = fs::canonicalize(expected_executable).map_err(runtime_stop_error)?;
    if record.expected_executable != expected {
        // 记录里的 executable 不属于当前应用：**拒绝误杀**，标记隔离。
        // 但隔离只是"这次不清理"，不能变成"以后永远启动不了"——若登记的 leader 已经
        // 死了，就没有任何东西需要杀，此时应当回收这条陈旧记录并继续启动。
        // （真机验收实测：残留的 quarantined 记录让应用每次启动都直接失败，
        //  且日志只有 `runtime_stop_failed` 一个代号，完全看不出原因。）
        let _ = quarantine_record(path, &mut record);
        if !process_alive(record.leader_pid) {
            return unregister(path);
        }
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "ownership registry 的 Sidecar executable 不属于当前应用，且登记的进程仍存活；拒绝误杀",
        ));
    }
    verify_executable_if_available(record.leader_pid, &expected)?;
    mark_cleaning(path, &mut record)?;
    terminate_registered(path, None, deadline, abort_on_shutdown)?;
    unregister(path)
}

pub fn refresh_registered(path: &Path) -> Result<(), AppError> {
    let Some(mut record) = read_registry(path)? else {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "Sidecar 运行时缺少 ownership registry",
        ));
    };
    ensure_active(&record)?;
    record.generation = record.generation.saturating_add(1);
    write_registry(path, &record, ErrorCode::RuntimeStopFailed)
}

pub fn begin_cleanup(path: &Path) -> Result<(), AppError> {
    let Some(mut record) = read_registry(path)? else {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "Sidecar 清理前缺少 ownership registry",
        ));
    };
    ensure_active(&record)?;
    mark_cleaning(path, &mut record)
}

pub fn retry_cleanup(path: &Path, expected_executable: &Path) -> Result<(), AppError> {
    let Some(mut record) = read_registry(path)? else {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "Sidecar 重试清理前缺少 ownership registry",
        ));
    };
    ensure_supported(&record)?;
    let expected = fs::canonicalize(expected_executable).map_err(runtime_stop_error)?;
    if record.expected_executable != expected {
        return quarantine(
            path,
            &mut record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                "quarantine executable 不属于当前应用；拒绝误杀",
            ),
        );
    }
    verify_executable_if_available(record.leader_pid, &expected)?;
    mark_cleaning(path, &mut record)
}

pub fn quarantine_registered(path: &Path) -> Result<(), AppError> {
    let Some(mut record) = read_registry(path)? else {
        return Ok(());
    };
    ensure_supported(&record)?;
    quarantine_record(path, &mut record)
}

pub fn unregister(path: &Path) -> Result<(), AppError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(runtime_stop_error(error)),
    }
}

pub fn terminate_registered(
    path: &Path,
    child: Option<&mut Child>,
    deadline: Instant,
    abort_on_shutdown: Option<&AtomicBool>,
) -> Result<(), AppError> {
    let Some(record) = read_registry(path)? else {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "清理 Sidecar 进程树前缺少 ownership registry",
        ));
    };
    ensure_supported(&record)?;
    if record.state != RegistryState::Cleaning {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "ownership registry 尚未进入 cleaning 状态",
        ));
    }
    terminate_pid_tree(record.leader_pid, child, deadline, abort_on_shutdown)
}

fn terminate_pid_tree(
    pid: u32,
    mut child: Option<&mut Child>,
    deadline: Instant,
    abort_on_shutdown: Option<&AtomicBool>,
) -> Result<(), AppError> {
    // 幂等：leader 已经不在时无需终止（例如进程在进入清理流程前自行退出）。
    // 必须先于 taskkill 判断，否则"对已不存在的 PID 调用 taskkill 返回非零"会被误判为清理故障。
    if !leader_alive(pid, &mut child)? {
        return Ok(());
    }
    // 首选系统级进程树终止，并**保留**结果用于失败判定与诊断：
    // 此前 `let _ = ...output()` 完全吞掉 taskkill 的退出码与 stderr，只要 leader 恰好在
    // 等待窗口内退出就会把"未能确认整棵树已终止"误报为成功（REL-024 语义要求
    // 返回成功前必须确认受管进程树已退出）。
    let taskkill = console_command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
    let taskkill_failure = match &taskkill {
        Ok(output) if output.status.success() => None,
        Ok(output) => Some(format!(
            "taskkill 退出码 {:?}；stderr: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim()
        )),
        Err(error) => Some(format!("taskkill 无法启动：{error}")),
    };
    if taskkill_failure.is_some() {
        // 第二手段：仅终止 leader（Child handle 强杀 + Stop-Process 兜底）。
        // 这不能替代进程树终止，只用于把 leader 收敛到可退出状态。
        if let Some(process) = child.as_deref_mut() {
            let _ = process.kill();
        }
        let _ = console_command("powershell.exe")
            .args([
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &format!("Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue"),
            ])
            .status();
    }
    while Instant::now() < deadline {
        if abort_on_shutdown.is_some_and(|intent| intent.load(Ordering::SeqCst)) {
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "旧 Runtime 恢复清理已交由退出流程接管",
            ));
        }
        if !leader_alive(pid, &mut child)? {
            return match taskkill_failure {
                None => Ok(()),
                Some(summary) => Err(AppError::new(
                    ErrorCode::RuntimeStopFailed,
                    format!(
                        "Sidecar 主进程已退出，但无法确认进程树已完整终止（{summary}）；请重试退出或恢复"
                    ),
                )),
            };
        }
        thread::sleep(Duration::from_millis(50));
    }
    let suffix = taskkill_failure
        .map(|summary| format!("；taskkill：{summary}"))
        .unwrap_or_default();
    Err(AppError::new(
        ErrorCode::RuntimeStopFailed,
        format!("已登记的 Sidecar 进程树在 5 秒后仍未退出{suffix}"),
    ))
}

fn leader_alive(pid: u32, child: &mut Option<&mut Child>) -> Result<bool, AppError> {
    if let Some(process) = child.as_deref_mut() {
        return Ok(process.try_wait().map_err(runtime_stop_error)?.is_none());
    }
    Ok(process_alive(pid))
}

fn process_alive(pid: u32) -> bool {
    console_command("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!("if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 0 }} else {{ exit 1 }}"),
        ])
        .status()
        .is_ok_and(|status| status.success())
}

fn verify_executable_if_available(pid: u32, expected: &Path) -> Result<(), AppError> {
    let output = console_command("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!("$p = Get-Process -Id {pid} -ErrorAction Stop; if ($p.Path) {{ [Console]::Out.Write($p.Path) }}"),
        ])
        .output()
        .map_err(runtime_stop_error)?;
    if !output.status.success() {
        return Ok(());
    }
    let actual = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if actual.is_empty() {
        return Ok(());
    }
    let actual = fs::canonicalize(actual).map_err(runtime_stop_error)?;
    if actual != expected {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "Sidecar 主进程路径与 ownership registry 不匹配；拒绝误杀",
        ));
    }
    Ok(())
}

fn ensure_active(record: &OwnershipRegistry) -> Result<(), AppError> {
    ensure_supported(record)?;
    if record.state != RegistryState::Active {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "ownership registry 已隔离，需在下次启动重新核验后清理",
        ));
    }
    Ok(())
}

fn ensure_supported(record: &OwnershipRegistry) -> Result<(), AppError> {
    if record.schema_version != 1 {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "ownership registry 版本不受支持",
        ));
    }
    Ok(())
}

fn quarantine<T>(
    path: &Path,
    record: &mut OwnershipRegistry,
    error: AppError,
) -> Result<T, AppError> {
    let _ = quarantine_record(path, record);
    Err(error)
}

fn quarantine_record(path: &Path, record: &mut OwnershipRegistry) -> Result<(), AppError> {
    record.state = RegistryState::Quarantined;
    write_registry(path, record, ErrorCode::RuntimeStopFailed)
}

fn mark_cleaning(path: &Path, record: &mut OwnershipRegistry) -> Result<(), AppError> {
    record.state = RegistryState::Cleaning;
    record.generation = record.generation.saturating_add(1);
    write_registry(path, record, ErrorCode::RuntimeStopFailed)
}

fn read_registry(path: &Path) -> Result<Option<OwnershipRegistry>, AppError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(runtime_stop_error(error)),
    };
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.len() > 65_536
    {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "ownership registry 文件类型或大小无效",
        ));
    }
    serde_json::from_slice(&fs::read(path).map_err(runtime_stop_error)?)
        .map(Some)
        .map_err(|error| AppError::new(ErrorCode::RuntimeStopFailed, error.to_string()))
}

fn write_registry(
    path: &Path,
    registry: &OwnershipRegistry,
    error_code: ErrorCode,
) -> Result<(), AppError> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::write(
            &temporary,
            serde_json::to_vec(registry)
                .map_err(|error| AppError::new(error_code, error.to_string()))?,
        )
        .map_err(|error| AppError::new(error_code, error.to_string()))?;
        fs::rename(&temporary, path).map_err(|error| AppError::new(error_code, error.to_string()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn runtime_stop_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::RuntimeStopFailed, error.to_string())
}

pub fn open_logs_directory(root: &Path, _: &AppHandle) -> Result<(), AppError> {
    fs::create_dir_all(root)
        .map_err(|error| AppError::new(ErrorCode::LogsUnavailable, error.to_string()))?;
    Command::new("explorer.exe")
        .arg(root)
        .spawn()
        .map(|_| ())
        .map_err(|error| AppError::new(ErrorCode::LogsUnavailable, error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    fn bundled_node() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime/node/win32-x64/node.exe")
    }

    /// 真实进程树：父 Node 进程保持运行，并派生一个同样保持运行的子进程。
    fn spawn_tree() -> (Child, u32) {
        let node = bundled_node();
        let mut child = console_command(node.to_str().expect("node 路径必须是 UTF-8"))
            .args([
                "-e",
                "const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)",
            ])
            .stdout(Stdio::piped())
            .spawn()
            .expect("无法启动测试用 Node 进程");
        let mut line = String::new();
        BufReader::new(child.stdout.take().expect("stdout 必须可读"))
            .read_line(&mut line)
            .expect("必须读到子进程 PID");
        let child_pid: u32 = line.trim().parse().expect("子进程 PID 必须是数字");
        (child, child_pid)
    }

    #[test]
    fn terminates_a_real_registered_process_tree_and_retires_the_record() {
        let node = bundled_node();
        assert!(
            node.is_file(),
            "测试前必须准备 bundled Node（pnpm runtime:prepare）"
        );
        let temporary = tempfile::tempdir().unwrap();
        let registry = temporary.path().join("ownership.json");
        let (mut leader, tree_child_pid) = spawn_tree();

        register(&registry, leader.id(), &node, "tree-test").unwrap();
        begin_cleanup(&registry).unwrap();
        terminate_registered(
            &registry,
            Some(&mut leader),
            Instant::now() + Duration::from_secs(8),
            None,
        )
        .unwrap();
        unregister(&registry).unwrap();

        assert!(!process_alive(tree_child_pid), "进程树子进程必须被终止");
        assert!(!registry.exists(), "ownership record 必须被退休");
    }

    #[test]
    fn dead_leader_is_idempotent_success_even_though_taskkill_would_fail() {
        // 已不存在的 leader：清理必须幂等成功，而不是把"taskkill 对死 PID 返回非零"
        // 误判为清理故障（回归保护：存活判定必须先于 taskkill）。
        let node = bundled_node();
        let temporary = tempfile::tempdir().unwrap();
        let registry = temporary.path().join("ownership.json");
        let dead_pid = 0x7FFF_FFF0_u32;
        register(&registry, dead_pid, &node, "dead-leader").unwrap();
        begin_cleanup(&registry).unwrap();
        terminate_registered(
            &registry,
            None,
            Instant::now() + Duration::from_secs(2),
            None,
        )
        .unwrap();
        unregister(&registry).unwrap();
        assert!(!registry.exists());
    }
}
