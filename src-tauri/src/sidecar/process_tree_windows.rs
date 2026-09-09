use crate::error::{AppError, ErrorCode};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;

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
        return quarantine(
            path,
            &mut record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                "ownership registry 的 Sidecar executable 不属于当前应用；拒绝误杀",
            ),
        );
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
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .output();
    while Instant::now() < deadline {
        if abort_on_shutdown.is_some_and(|intent| intent.load(Ordering::SeqCst)) {
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "旧 Runtime 恢复清理已交由退出流程接管",
            ));
        }
        if let Some(process) = child.as_deref_mut() {
            if process.try_wait().map_err(runtime_stop_error)?.is_some() {
                return Ok(());
            }
        } else if !process_alive(pid) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    Err(AppError::new(
        ErrorCode::RuntimeStopFailed,
        "已登记的 Sidecar 进程树在 5 秒后仍未退出",
    ))
}

fn process_alive(pid: u32) -> bool {
    Command::new("powershell.exe")
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
    let output = Command::new("powershell.exe")
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
                .map_err(|error| AppError::new(error_code.clone(), error.to_string()))?,
        )
        .map_err(|error| AppError::new(error_code.clone(), error.to_string()))?;
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
    Command::new("cmd")
        .args(["/C", "start", "", &root.display().to_string()])
        .spawn()
        .map(|_| ())
        .map_err(|error| AppError::new(ErrorCode::LogsUnavailable, error.to_string()))
}
