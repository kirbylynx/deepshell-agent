use crate::error::{AppError, ErrorCode};
use serde::{Deserialize, Serialize};
use std::os::windows::process::CommandExt;
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
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

/// `taskkill` 的单次等待上限；实际等待还会被调用方的 deadline 进一步收紧
/// （退出路径的 deadline 仅 5 秒，工具本身不得越过调用方承诺的窗口）。
const TASKKILL_TIMEOUT: Duration = Duration::from_secs(15);

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
    if verify_executable_if_available(pid, &expected) == ExecutableMatch::Mismatch {
        return Err(AppError::new(
            ErrorCode::RuntimeStartFailed,
            "Sidecar 主进程路径与预期不符；拒绝登记 ownership registry",
        ));
    }
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
        return match process_state(record.leader_pid) {
            ProcessState::Dead => unregister(path),
            ProcessState::Alive => Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "ownership registry 的 Sidecar executable 不属于当前应用，且登记的进程仍存活；拒绝误杀",
            )),
            ProcessState::Unknown => Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "ownership registry 的 Sidecar executable 不属于当前应用，且无法确认登记进程状态；拒绝误杀",
            )),
        };
    }
    match verify_executable_if_available(record.leader_pid, &expected) {
        ExecutableMatch::Matches => {}
        ExecutableMatch::Mismatch => {
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "ownership registry 的 Sidecar 主进程路径不匹配（可能已被 PID 复用）；拒绝误杀",
            ))
        }
        ExecutableMatch::Unavailable => {
            // 无法校验身份（例如 PowerShell 被企业策略禁用或组件损坏）：**不终止任何进程**
            // ——失败关闭的安全目标已经达成；此时若继续报错，会把"查询工具故障"变成
            // "应用永远无法启动"。因此隔离记录、跳过本次清理并继续启动（下次启动重试）。
            quarantine_record(path, &mut record)?;
            return Ok(());
        }
    }
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
    match verify_executable_if_available(record.leader_pid, &expected) {
        ExecutableMatch::Matches => mark_cleaning(path, &mut record),
        ExecutableMatch::Mismatch => quarantine(
            path,
            &mut record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                "quarantine 主进程路径不匹配（可能已被 PID 复用）；拒绝误杀",
            ),
        ),
        ExecutableMatch::Unavailable => quarantine(
            path,
            &mut record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                "无法校验 quarantine 主进程身份；拒绝在未知状态下清理（请检查 PowerShell 是否可用/被策略禁用）",
            ),
        ),
    }
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
    // 幂等与三态：只有**确认已退出**才算幂等成功；"无法确认"必须失败关闭。
    // 此前把存活查询失败当作"已退出"直接返回成功，可能漏清理却表现为成功。
    match leader_state(pid, &mut child)? {
        ProcessState::Dead => return Ok(()),
        ProcessState::Alive => {}
        ProcessState::Unknown => {
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "无法确认 Sidecar 主进程状态（进程查询不可用）；拒绝在未知状态下继续",
            ))
        }
    }
    // 首选系统级进程树终止，并**保留**结果用于失败判定与诊断：
    // 此前 `let _ = ...output()` 完全吞掉 taskkill 的退出码与 stderr，只要 leader 恰好在
    // 等待窗口内退出就会把"未能确认整棵树已终止"误报为成功（REL-024 语义要求
    // 返回成功前必须确认受管进程树已退出）。
    let mut taskkill_command = console_command("taskkill");
    taskkill_command.args(["/PID", &pid.to_string(), "/T", "/F"]);
    // 等待上限取"调用方剩余窗口"与固定上限的较小值：退出路径的 deadline 只有 5 秒，
    // 工具本身不得越过它多等；剩余为 0 时立即超时并按失败关闭处理。
    let taskkill_timeout = deadline
        .saturating_duration_since(Instant::now())
        .min(TASKKILL_TIMEOUT);
    let taskkill = run_command_with_timeout(&mut taskkill_command, taskkill_timeout);
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
        let mut stop = console_command("powershell.exe");
        stop.args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            &format!("Stop-Process -Id {pid} -Force -ErrorAction SilentlyContinue"),
        ]);
        let _ = run_command_with_timeout(&mut stop, Duration::from_secs(5));
    }
    while Instant::now() < deadline {
        if abort_on_shutdown.is_some_and(|intent| intent.load(Ordering::SeqCst)) {
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "旧 Runtime 恢复清理已交由退出流程接管",
            ));
        }
        match leader_state(pid, &mut child)? {
            ProcessState::Dead => {
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
            ProcessState::Alive => {}
            ProcessState::Unknown => {
                return Err(AppError::new(
                    ErrorCode::RuntimeStopFailed,
                    "无法确认 Sidecar 主进程是否已退出（进程查询不可用）；请重试退出或恢复",
                ))
            }
        }
        thread::sleep(Duration::from_millis(100));
    }
    let suffix = taskkill_failure
        .map(|summary| format!("；taskkill：{summary}"))
        .unwrap_or_default();
    Err(AppError::new(
        ErrorCode::RuntimeStopFailed,
        format!("已登记的 Sidecar 进程树超过等待时限仍未退出{suffix}"),
    ))
}

fn leader_state(pid: u32, child: &mut Option<&mut Child>) -> Result<ProcessState, AppError> {
    if let Some(process) = child.as_deref_mut() {
        return Ok(
            if process.try_wait().map_err(runtime_stop_error)?.is_none() {
                ProcessState::Alive
            } else {
                ProcessState::Dead
            },
        );
    }
    Ok(process_state(pid))
}

/// 卸载兜底清理的可机器判定结果（NSIS PREUNINSTALL hook 依赖）。
pub enum UninstallCleanup {
    /// 已确认当前安装目录下没有受管进程（可能清理了若干进程）。
    Clean { terminated: Vec<u32> },
    /// 主程序仍在运行：卸载器应提示用户先关闭应用（不得强杀主程序）。
    AppRunning { pid: u32 },
    /// 无法证明当前安装目录未被受管进程占用（例如进程枚举不可用）：必须失败关闭。
    Unverifiable { reason: String },
}

/// 维护命令的清理入口（设计 §10 / REQ-1407 的卸载兜底）。
///
/// 规则：
/// 1. 主程序（安装目录下的应用可执行文件）仍在运行 → `AppRunning`，不终止任何进程；
/// 2. ownership record 的 `expected_executable` 规范化为当前安装目录内的 Node 路径时，
///    校验 leader 身份后终止其进程树并**退休**记录；指向另一份安装/便携目录的记录
///    **不终止、不移动**；
/// 3. 无论记录如何，都对当前安装目录的**精确可执行路径**枚举一次并清理路径/身份
///    均可验证的进程；枚举不可用 → `Unverifiable`；
/// 4. 禁止按进程名批量终止，禁止终止主程序本身。
pub fn cleanup_for_uninstall(
    install_root: &Path,
    app_data_root: &Path,
    self_pid: u32,
    deadline: Instant,
) -> Result<UninstallCleanup, AppError> {
    let expected_node = install_root
        .join("runtime")
        .join("node")
        .join("win32-x64")
        .join("node.exe");
    let expected_node = fs::canonicalize(&expected_node).map_err(|error| {
        AppError::new(
            ErrorCode::RuntimeStopFailed,
            format!("无法解析安装目录内的 Node 路径：{error}"),
        )
    })?;

    // 1. 主程序仍在运行 → 交给卸载器提示用户先关闭应用。
    for main_name in ["deepshell-agent.exe", "DeepShell Agent.exe"] {
        let main_exe = install_root.join(main_name);
        let Ok(main_exe) = fs::canonicalize(&main_exe) else {
            continue;
        };
        let running = match enumerate_pids_by_executable(&main_exe, self_pid) {
            Ok(pids) => pids,
            Err(error) => {
                return Ok(UninstallCleanup::Unverifiable {
                    reason: format!(
                        "无法枚举主程序进程：{error}（请检查 PowerShell 是否可用/被策略禁用）"
                    ),
                })
            }
        };
        if let Some(pid) = running.first() {
            return Ok(UninstallCleanup::AppRunning { pid: *pid });
        }
    }

    let mut terminated = Vec::new();
    let registry_path = app_data_root.join("runtime-state").join("ownership.json");

    // 2. ownership record：只处理**可验证属于当前安装且状态为 active**的记录。
    match read_registry(&registry_path) {
        Ok(Some(mut record)) => {
            let record_target = fs::canonicalize(&record.expected_executable)
                .ok()
                .filter(|target| target == &expected_node);
            if record_target.is_some() && record.state == RegistryState::Active {
                match process_state(record.leader_pid) {
                    ProcessState::Dead => {
                        // 记录指向已退出的进程：没有东西需要终止，退休该记录。
                        unregister(&registry_path)?;
                    }
                    ProcessState::Alive => {
                        match verify_executable_if_available(record.leader_pid, &expected_node) {
                            ExecutableMatch::Matches => {
                                terminate_pid_tree(record.leader_pid, None, deadline, None)?;
                                terminated.push(record.leader_pid);
                                unregister(&registry_path)?;
                            }
                            ExecutableMatch::Mismatch => {
                                // PID 已被复用为其它进程：绝不终止；该记录不再代表有效
                                // 所有权，标记隔离，交由枚举路径与下次启动处理。
                                quarantine_record(&registry_path, &mut record)?;
                            }
                            ExecutableMatch::Unavailable => {
                                return Ok(UninstallCleanup::Unverifiable {
                                    reason: "无法校验 ownership registry 记录的主进程身份（请检查 PowerShell 是否可用/被策略禁用）".into(),
                                });
                            }
                        }
                    }
                    ProcessState::Unknown => {
                        return Ok(UninstallCleanup::Unverifiable {
                            reason: "无法确认 ownership registry 记录的主进程状态".into(),
                        });
                    }
                }
            }
            // 记录属于另一份安装/便携目录、已损坏或非 active（quarantined/cleaning）：
            // 不终止其进程、不移动记录，继续做精确路径枚举。
        }
        Ok(None) => {}
        Err(error) => {
            let _ = crate::logging::record_detailed(
                &app_data_root.join("logs"),
                "error",
                "maintenance_record_unreadable",
                Some(ErrorCode::RuntimeStopFailed),
                None,
                Some(error.diagnostic_message()),
            );
        }
    }

    // 3. 精确路径枚举兜底：只清理可执行路径与身份都可验证的受管进程。
    let remaining = match enumerate_pids_by_executable(&expected_node, self_pid) {
        Ok(pids) => pids,
        Err(error) => {
            let reason = format!(
                "无法枚举受管 Sidecar 进程：{error}（请检查 PowerShell 是否可用/被策略禁用）"
            );
            return Ok(UninstallCleanup::Unverifiable { reason });
        }
    };
    for pid in remaining {
        if terminated.contains(&pid) {
            continue;
        }
        match verify_executable_if_available(pid, &expected_node) {
            ExecutableMatch::Matches => {
                terminate_pid_tree(pid, None, deadline, None)?;
                terminated.push(pid);
            }
            ExecutableMatch::Mismatch => {
                // 枚举与校验之间 PID 已易主：跳过，不是我们的进程。
            }
            ExecutableMatch::Unavailable => {
                return Ok(UninstallCleanup::Unverifiable {
                    reason: format!(
                        "无法校验受管进程 {pid} 的身份（请检查 PowerShell 是否可用/被策略禁用）"
                    ),
                });
            }
        }
    }

    let outcome = UninstallCleanup::Clean { terminated };
    let summary = match &outcome {
        UninstallCleanup::Clean { terminated } => format!("clean; terminated={terminated:?}"),
        UninstallCleanup::AppRunning { pid } => format!("app-running; pid={pid}"),
        UninstallCleanup::Unverifiable { reason } => format!("unverifiable; {reason}"),
    };
    let _ = crate::logging::record_detailed(
        &app_data_root.join("logs"),
        "info",
        "maintenance_cleanup",
        None,
        None,
        Some(&summary),
    );
    Ok(outcome)
}

/// 通过 CIM 枚举可执行文件路径精确匹配（规范化、大小写不敏感）的进程。
///
/// 目标路径经**环境变量**传给子进程，避免把用户可控路径拼接进 PowerShell 命令行；
/// 结果排除 `exclude_pid`（维护命令自身）。
///
/// ⚠️ Windows 的 `canonicalize` 返回 `\\?\` 前缀形式，而 CIM 的 `ExecutablePath`
/// 是普通形式；必须先去前缀再比较，否则枚举会假阴性（W5 实测：应用运行中的主程序
/// 检测曾因此失效，维护命令误把运行中的应用当作未运行）。
fn enumerate_pids_by_executable(expected: &Path, exclude_pid: u32) -> Result<Vec<u32>, AppError> {
    let expected = crate::paths::strip_verbatim_prefix(expected.to_path_buf());
    let script = "$target = [System.IO.Path]::GetFullPath($env:DEEPSHELL_MAINTENANCE_TARGET); \
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ([System.IO.Path]::GetFullPath($_.ExecutablePath)).Equals($target, [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { [Console]::Out.WriteLine($_.ProcessId) }";
    let mut command = console_command("powershell.exe");
    command
        .env("DEEPSHELL_MAINTENANCE_TARGET", &expected)
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            script,
        ]);
    let output =
        run_command_with_timeout(&mut command, Duration::from_secs(10)).map_err(|error| {
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                format!("进程枚举未完成：{}", error.diagnostic_message()),
            )
        })?;
    if !output.status.success() {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            format!(
                "进程枚举失败：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }
    let mut pids = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let pid: u32 = line.parse().map_err(|_| {
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                format!("无法解析进程枚举输出：{line}"),
            )
        })?;
        if pid != exclude_pid {
            pids.push(pid);
        }
    }
    pids.sort_unstable();
    pids.dedup();
    Ok(pids)
}

/// 进程存活三态：**"无法确认"必须与"已退出"区分**，否则会发生两类错误：
/// 误把仍存活的受管进程当作已退出（漏清理却报成功），或在身份无法校验时继续终止。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessState {
    Alive,
    Dead,
    Unknown,
}

/// 在超时内运行外部命令并收集输出。
///
/// 这些命令全部是无界面后台工具；没有超时保护时，PowerShell 挂起会让维护命令
/// 与 NSIS `ExecWait` 一起无限等待。输出量都很小（pid 列表 / 单行路径），不会填满管道。
fn run_command_with_timeout(
    command: &mut Command,
    timeout: Duration,
) -> Result<std::process::Output, AppError> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(runtime_stop_error)?;
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait().map_err(runtime_stop_error)?.is_some() {
            break;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                format!("外部命令在 {timeout:?} 内未完成，已终止"),
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
    child.wait_with_output().map_err(runtime_stop_error)
}

/// 用 `tasklist` 判定进程存活。
///
/// 选择 tasklist 而非 PowerShell：无需 PS 运行时（更快、对 PS 策略故障不敏感），
/// 且任务不存在时返回成功但输出无匹配行，可以可靠区分"已退出"与"查询失败"。
fn process_state(pid: u32) -> ProcessState {
    let mut command = console_command("tasklist");
    command.args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"]);
    match run_command_with_timeout(&mut command, Duration::from_secs(5)) {
        Ok(output) if output.status.success() => {
            let text = String::from_utf8_lossy(&output.stdout);
            if text.contains(&format!("\"{pid}\",")) {
                ProcessState::Alive
            } else {
                ProcessState::Dead
            }
        }
        _ => ProcessState::Unknown,
    }
}

/// 进程身份校验结果。**"无法校验"必须与"身份匹配"区分**：
/// 前者在清理路径上必须失败关闭（不得因为查不到路径就认为可以终止）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ExecutableMatch {
    Matches,
    Mismatch,
    Unavailable,
}

fn verify_executable_if_available(pid: u32, expected: &Path) -> ExecutableMatch {
    let mut command = console_command("powershell.exe");
    command.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        &format!("$p = Get-Process -Id {pid} -ErrorAction Stop; if ($p.Path) {{ [Console]::Out.Write($p.Path) }}"),
    ]);
    let output = match run_command_with_timeout(&mut command, Duration::from_secs(5)) {
        Ok(output) if output.status.success() => output,
        _ => return ExecutableMatch::Unavailable,
    };
    let actual = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    if actual.is_empty() {
        return ExecutableMatch::Unavailable;
    }
    let Ok(actual) = fs::canonicalize(actual) else {
        return ExecutableMatch::Unavailable;
    };
    if actual == expected {
        ExecutableMatch::Matches
    } else {
        ExecutableMatch::Mismatch
    }
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

        assert_eq!(
            process_state(tree_child_pid),
            ProcessState::Dead,
            "进程树子进程必须被终止"
        );
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

    #[test]
    fn process_state_distinguishes_alive_and_dead_pids() {
        assert_eq!(process_state(std::process::id()), ProcessState::Alive);
        assert_eq!(process_state(0x7FFF_FFF0), ProcessState::Dead);
    }

    #[test]
    fn run_command_with_timeout_kills_a_hanging_command() {
        let node = bundled_node();
        assert!(node.is_file(), "测试前必须准备 bundled Node");
        let mut command = console_command(node.to_str().expect("node 路径必须是 UTF-8"));
        command.args(["-e", "setInterval(() => {}, 1000)"]);
        let started = Instant::now();
        let error = run_command_with_timeout(&mut command, Duration::from_millis(800)).unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(15),
            "超时必须及时返回"
        );
        assert!(
            error.diagnostic_message().contains("未完成"),
            "{}",
            error.diagnostic_message()
        );
    }

    /// 构造一个最小安装布局：把真实 Node 复制为 `<root>/runtime/node/win32-x64/node.exe`。
    ///
    /// 用复制而非硬链接：Windows 硬链接不能跨卷，而临时目录与 bundled Node 的位置
    /// 不受本测试控制（曾出现 CrossesDevices）。
    fn make_install_layout(root: &Path) -> PathBuf {
        let node_directory = root.join("runtime").join("node").join("win32-x64");
        fs::create_dir_all(&node_directory).unwrap();
        let node = node_directory.join("node.exe");
        fs::copy(bundled_node(), &node).unwrap();
        node
    }

    /// 在项目所在卷上创建临时目录（减少与项目文件的跨卷差异）。
    fn project_volume_tempdir() -> tempfile::TempDir {
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime/staging");
        fs::create_dir_all(&base).unwrap();
        tempfile::tempdir_in(base).unwrap()
    }

    fn write_test_record(registry: &Path, expected: &Path, leader_pid: u32, state: &str) {
        let record = serde_json::json!({
            "schemaVersion": 1,
            "instanceId": "test",
            "ownershipToken": "test-token",
            "generation": 1,
            "state": state,
            "leaderPid": leader_pid,
            "expectedExecutable": expected.to_string_lossy(),
        });
        fs::write(registry, serde_json::to_vec(&record).unwrap()).unwrap();
    }

    /// 启动一个与 DeepShell 无关的存活进程（模拟"PID 被复用给别的进程"）。
    fn spawn_unrelated_victim() -> Child {
        console_command("powershell.exe")
            .args(["-NoProfile", "-Command", "Start-Sleep -Seconds 300"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("无法启动 victim 进程")
    }

    #[test]
    fn cleanup_does_not_terminate_a_reused_pid_and_quarantines_the_record() {
        // F-WR-01 回归保护：record 属于当前安装且状态 active，但 leader PID 已被复用给
        // 无关进程时，**绝不能终止该进程**；记录应被隔离而不是删除。
        let node = bundled_node();
        assert!(node.is_file(), "测试前必须准备 bundled Node");
        let install = project_volume_tempdir();
        let expected = make_install_layout(install.path());
        let app_data = project_volume_tempdir();
        fs::create_dir_all(app_data.path().join("runtime-state")).unwrap();
        let registry = app_data.path().join("runtime-state").join("ownership.json");
        let mut victim = spawn_unrelated_victim();
        write_test_record(&registry, &expected, victim.id(), "active");

        let outcome = cleanup_for_uninstall(
            install.path(),
            app_data.path(),
            std::process::id(),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();

        match outcome {
            UninstallCleanup::Clean { terminated } => {
                assert!(terminated.is_empty(), "复用的 PID 不得被终止")
            }
            UninstallCleanup::AppRunning { .. } | UninstallCleanup::Unverifiable { .. } => {
                panic!("期望 Clean（无受管进程），得到其它结果")
            }
        }
        assert!(victim.try_wait().unwrap().is_none(), "无关进程必须保持存活");
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry).unwrap()).unwrap();
        assert_eq!(record["state"], "quarantined", "复用 PID 的记录必须被隔离");

        let _ = victim.kill();
        let _ = victim.wait();
    }

    #[test]
    fn cleanup_ignores_a_quarantined_record_for_the_current_install() {
        // F-WR-01：非 active（quarantined）记录不得直接触发终止。
        let node = bundled_node();
        assert!(node.is_file(), "测试前必须准备 bundled Node");
        let install = project_volume_tempdir();
        let expected = make_install_layout(install.path());
        let app_data = project_volume_tempdir();
        fs::create_dir_all(app_data.path().join("runtime-state")).unwrap();
        let registry = app_data.path().join("runtime-state").join("ownership.json");
        let mut victim = spawn_unrelated_victim();
        write_test_record(&registry, &expected, victim.id(), "quarantined");

        let outcome = cleanup_for_uninstall(
            install.path(),
            app_data.path(),
            std::process::id(),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();

        match outcome {
            UninstallCleanup::Clean { terminated } => assert!(terminated.is_empty()),
            UninstallCleanup::AppRunning { .. } | UninstallCleanup::Unverifiable { .. } => {
                panic!("期望 Clean（无受管进程），得到其它结果")
            }
        }
        assert!(
            victim.try_wait().unwrap().is_none(),
            "隔离记录指向的进程必须保持存活"
        );
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry).unwrap()).unwrap();
        assert_eq!(record["state"], "quarantined", "隔离状态必须保留");

        let _ = victim.kill();
        let _ = victim.wait();
    }

    #[test]
    fn cleanup_retires_a_record_whose_leader_is_dead() {
        let node = bundled_node();
        assert!(node.is_file(), "测试前必须准备 bundled Node");
        let install = project_volume_tempdir();
        let expected = make_install_layout(install.path());
        let app_data = project_volume_tempdir();
        fs::create_dir_all(app_data.path().join("runtime-state")).unwrap();
        let registry = app_data.path().join("runtime-state").join("ownership.json");
        write_test_record(&registry, &expected, 0x7FFF_FFF0, "active");

        let outcome = cleanup_for_uninstall(
            install.path(),
            app_data.path(),
            std::process::id(),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();

        match outcome {
            UninstallCleanup::Clean { terminated } => assert!(terminated.is_empty()),
            UninstallCleanup::AppRunning { .. } | UninstallCleanup::Unverifiable { .. } => {
                panic!("期望 Clean（无受管进程），得到其它结果")
            }
        }
        assert!(!registry.exists(), "leader 已死的记录必须被退休");
    }

    #[test]
    fn cleanup_keeps_a_foreign_record_and_its_process_untouched() {
        // 记录属于另一份安装目录：不终止其进程、不移动记录。
        let node = bundled_node();
        assert!(node.is_file(), "测试前必须准备 bundled Node");
        let install = tempfile::tempdir().unwrap();
        make_install_layout(install.path());
        let foreign = project_volume_tempdir();
        let foreign_node = make_install_layout(foreign.path());
        let app_data = tempfile::tempdir().unwrap();
        fs::create_dir_all(app_data.path().join("runtime-state")).unwrap();
        let registry = app_data.path().join("runtime-state").join("ownership.json");
        let mut victim = spawn_unrelated_victim();
        write_test_record(&registry, &foreign_node, victim.id(), "active");

        let outcome = cleanup_for_uninstall(
            install.path(),
            app_data.path(),
            std::process::id(),
            Instant::now() + Duration::from_secs(10),
        )
        .unwrap();

        match outcome {
            UninstallCleanup::Clean { terminated } => assert!(terminated.is_empty()),
            UninstallCleanup::AppRunning { .. } | UninstallCleanup::Unverifiable { .. } => {
                panic!("期望 Clean（无受管进程），得到其它结果")
            }
        }
        assert!(
            victim.try_wait().unwrap().is_none(),
            "外来记录指向的进程必须保持存活"
        );
        assert!(registry.exists(), "外来记录必须保留");
        let record: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry).unwrap()).unwrap();
        assert_eq!(record["state"], "active", "外来记录不得被改写");

        let _ = victim.kill();
        let _ = victim.wait();
    }
}
