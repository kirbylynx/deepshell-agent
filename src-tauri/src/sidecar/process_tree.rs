use crate::error::{AppError, ErrorCode};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    ffi::CStr,
    fs,
    mem::{size_of, zeroed},
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::{Child, Command},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};
use tauri::AppHandle;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProcessIdentity {
    pid: u32,
    parent_pid: u32,
    process_group_id: u32,
    session_id: i32,
    started_seconds: u64,
    started_microseconds: u64,
    executable: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnershipRegistry {
    schema_version: u32,
    instance_id: String,
    ownership_token: String,
    generation: u64,
    state: RegistryState,
    leader: ProcessIdentity,
    #[serde(default)]
    groups: Vec<ProcessIdentity>,
    members: Vec<ProcessIdentity>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum RegistryState {
    Active,
    Cleaning,
    Quarantined,
}

#[derive(Default)]
struct StoppedGroupsGuard {
    groups: Vec<i32>,
}

impl StoppedGroupsGuard {
    fn stop(&mut self, pgid: i32) -> Result<(), AppError> {
        if self.groups.contains(&pgid) {
            return Ok(());
        }
        validate_group(pgid)?;
        signal_group(pgid, libc::SIGSTOP)?;
        self.groups.push(pgid);
        Ok(())
    }
}

impl Drop for StoppedGroupsGuard {
    fn drop(&mut self) {
        // 任意错误路径都必须先恢复已冻结进程，不能把失去 Supervisor 所有权的进程
        // 永久留在 SIGSTOP 状态。正常清理后这里会得到 ESRCH，并按幂等成功处理。
        for group in &self.groups {
            let _ = signal_group(*group, libc::SIGCONT);
        }
    }
}

pub fn register(
    path: &Path,
    pid: u32,
    expected_executable: &Path,
    instance_id: &str,
) -> Result<(), AppError> {
    let identity = inspect_recorded(pid)?.ok_or_else(|| {
        AppError::new(
            ErrorCode::RuntimeStartFailed,
            "DSH 在建立 ownership registry 前退出",
        )
    })?;
    let expected = fs::canonicalize(expected_executable).map_err(runtime_stop_error)?;
    if identity.executable != expected
        || identity.process_group_id != pid
        || identity.session_id != pid as i32
    {
        return Err(AppError::new(
            ErrorCode::RuntimeStartFailed,
            "DSH 进程身份不符合独立 Session/Process Group 契约",
        ));
    }
    let members = inspect_group(pid as i32)?;
    let registry = OwnershipRegistry {
        schema_version: 1,
        instance_id: instance_id.to_owned(),
        ownership_token: uuid::Uuid::new_v4().to_string(),
        generation: 1,
        state: RegistryState::Active,
        leader: identity.clone(),
        groups: vec![identity],
        members,
    };
    write_registry(path, &registry, ErrorCode::RuntimeStartFailed)
}

/// ownership registry 尚未成功落盘时的故障清理。
///
/// 先冻结从已验证 leader ancestry 发现的每个独立 session/process group，连续两次
/// 扫描没有新增 group 后再统一终止，避免注册失败路径只清理 Host group 而遗漏 DSH
/// 已创建的 detached Tool/Shell group。无法清理时会尽力写入 quarantine 元数据，且
/// 一定把清理错误返回给调用方。
pub fn terminate_unregistered_spawn(
    path: &Path,
    child: &mut Child,
    pid: u32,
    expected_executable: &Path,
    instance_id: &str,
    deadline: Instant,
) -> Result<(), AppError> {
    if child.id() != pid {
        let cleanup = kill_and_reap_spawned_child(child);
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            format!(
                "注册失败清理收到的 Child handle 与 leader PID 不一致；Child 回收结果：{cleanup:?}"
            ),
        ));
    }
    let expected = match fs::canonicalize(expected_executable) {
        Ok(expected) => expected,
        Err(error) => {
            let cleanup = kill_and_reap_spawned_child(child);
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                format!("无法解析预期 DSH executable（{error}）；Child 回收结果：{cleanup:?}"),
            ));
        }
    };
    let leader = match inspect_recorded(pid) {
        Ok(Some(identity)) => identity,
        Ok(None) => {
            kill_and_reap_spawned_child(child)?;
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "无法读取 DSH leader 身份；已通过可信 Child handle 强制回收 leader",
            ));
        }
        Err(identity_error) => {
            return match kill_and_reap_spawned_child(child) {
                Ok(()) => Err(AppError::new(
                    ErrorCode::RuntimeStopFailed,
                    format!(
                        "无法读取 DSH leader 身份（{identity_error}）；已通过可信 Child handle 强制回收 leader"
                    ),
                )),
                Err(cleanup_error) => Err(AppError::new(
                    ErrorCode::RuntimeStopFailed,
                    format!(
                        "无法读取 DSH leader 身份（{identity_error}），且 Child handle 回收失败（{cleanup_error}）"
                    ),
                )),
            };
        }
    };
    if leader.executable != expected
        || leader.process_group_id != pid
        || leader.session_id != pid as i32
    {
        let cleanup = kill_and_reap_spawned_child(child);
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            format!(
                "注册失败后的 DSH leader 身份不满足进程组清理条件；Child 回收结果：{cleanup:?}"
            ),
        ));
    }

    let mut groups = vec![leader.clone()];
    let freeze_deadline = deadline
        .checked_sub(Duration::from_secs(4))
        .unwrap_or_else(Instant::now);
    let mut stopped_groups = StoppedGroupsGuard::default();
    let mut stable_scans = 0_u8;
    let mut discovery_error = None;
    while Instant::now() < freeze_deadline && stable_scans < 2 {
        let processes = match inspect_all() {
            Ok(processes) => processes,
            Err(error) => {
                discovery_error = Some(error);
                break;
            }
        };
        if let Some(current) = processes.iter().find(|process| process.pid == pid) {
            if !same_owned_process(current, &leader) {
                discovery_error = Some(AppError::new(
                    ErrorCode::RuntimeStopFailed,
                    "注册失败清理期间 DSH leader 身份发生变化",
                ));
                break;
            }
        }
        let descendants = descendants_of(pid, &processes);
        let descendant_pids = descendants
            .iter()
            .map(|process| process.pid)
            .collect::<HashSet<_>>();
        let before = groups.len();
        for process in &descendants {
            if process.pid == process.process_group_id
                && process.session_id == process.process_group_id as i32
                && descendant_pids.contains(&process.pid)
                && !groups
                    .iter()
                    .any(|root| root.process_group_id == process.process_group_id)
            {
                groups.push(process.clone());
            }
        }
        if let Some(reused) = reused_group_root(&groups, &processes) {
            discovery_error = Some(AppError::new(
                ErrorCode::RuntimeStopFailed,
                format!(
                    "注册失败清理期间 owned process group {} 已被复用",
                    reused.process_group_id
                ),
            ));
            break;
        }
        for group in &groups {
            if let Err(error) = stopped_groups.stop(group.process_group_id as i32) {
                discovery_error = Some(error);
                break;
            }
        }
        if discovery_error.is_some() {
            break;
        }
        stable_scans = if groups.len() == before {
            stable_scans.saturating_add(1)
        } else {
            0
        };
        thread::sleep(Duration::from_millis(25));
    }
    if stable_scans < 2 && discovery_error.is_none() {
        discovery_error = Some(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "注册失败清理未在期限内完成稳定 ownership group 采样",
        ));
    }

    let mut group_ids = groups
        .iter()
        .map(|root| root.process_group_id as i32)
        .collect::<Vec<_>>();
    group_ids.sort_unstable();
    group_ids.dedup();
    let cleanup_result = (|| {
        for group in &group_ids {
            signal_group(*group, libc::SIGTERM)?;
            signal_group(*group, libc::SIGCONT)?;
        }
        let cleanup_deadline = deadline
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);
        let mut child_ref = Some(child);
        if !wait_for_groups(
            &mut child_ref,
            &group_ids,
            cleanup_deadline.min(Instant::now() + Duration::from_secs(2)),
            None,
        )? {
            for group in group_ids.iter().filter(|group| group_exists(**group)) {
                signal_group(*group, libc::SIGKILL)?;
            }
            if !wait_for_groups(&mut child_ref, &group_ids, cleanup_deadline, None)? {
                return Err(AppError::new(
                    ErrorCode::RuntimeStopFailed,
                    "注册失败后发现的 DSH 进程组未在期限内退出",
                ));
            }
        }
        verify_groups_absent(&group_ids, deadline)
    })();

    if discovery_error.is_some() || cleanup_result.is_err() {
        let error = cleanup_result
            .err()
            .or(discovery_error)
            .expect("错误分支必须包含清理或采样错误");
        let processes = inspect_all().unwrap_or_default();
        let mut record = OwnershipRegistry {
            schema_version: 1,
            instance_id: instance_id.to_owned(),
            ownership_token: uuid::Uuid::new_v4().to_string(),
            generation: 1,
            state: RegistryState::Quarantined,
            leader,
            groups,
            members: processes
                .into_iter()
                .filter(|process| {
                    group_ids.contains(&(process.process_group_id as i32))
                        && process.session_id == process.process_group_id as i32
                })
                .collect(),
        };
        let _ = quarantine_record(path, &mut record);
        return Err(error);
    }
    Ok(())
}

fn kill_and_reap_spawned_child(child: &mut Child) -> Result<(), AppError> {
    if child.try_wait().map_err(runtime_stop_error)?.is_some() {
        return Ok(());
    }
    child.kill().map_err(runtime_stop_error)?;
    child.wait().map_err(runtime_stop_error)?;
    Ok(())
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
    if record.leader.executable != expected {
        return quarantine(
            path,
            &mut record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                "ownership registry 的 Sidecar executable 不属于当前应用；拒绝误杀",
            ),
        );
    }
    if let Some(current) = inspect_recorded(record.leader.pid)? {
        if !same_owned_process(&current, &record.leader) {
            return quarantine(
                path,
                &mut record,
                AppError::new(
                    ErrorCode::RuntimeStopFailed,
                    "ownership registry 与当前 OS 主进程身份不匹配；拒绝误杀",
                ),
            );
        }
        if record.state == RegistryState::Active {
            refresh_record(path, &mut record)?;
        } else {
            verify_retryable_members(path, &mut record)?;
        }
    } else {
        let live_groups = verify_registered_groups(path, &mut record)?;
        if live_groups.is_empty() {
            fs::remove_file(path).map_err(runtime_stop_error)?;
            return Ok(());
        }
    }
    mark_cleaning(path, &mut record)?;
    if let Err(error) = terminate_registered(path, None, deadline, abort_on_shutdown) {
        let _ = quarantine_record(path, &mut record);
        return Err(error);
    }
    fs::remove_file(path).map_err(runtime_stop_error)
}

pub fn refresh_registered(path: &Path) -> Result<(), AppError> {
    let Some(mut record) = read_registry(path)? else {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "Sidecar 运行时缺少 ownership registry",
        ));
    };
    ensure_active(&record)?;
    let Some(current) = inspect_recorded(record.leader.pid)? else {
        return verify_registered_groups(path, &mut record).map(|_| ());
    };
    if !same_owned_process(&current, &record.leader) {
        return quarantine(
            path,
            &mut record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                "Sidecar 主进程身份发生变化；ownership registry 已隔离",
            ),
        );
    }
    refresh_record(path, &mut record)
}

fn same_owned_process(current: &ProcessIdentity, recorded: &ProcessIdentity) -> bool {
    current.pid == recorded.pid
        && current.process_group_id == recorded.process_group_id
        && current.session_id == recorded.session_id
        && current.started_seconds == recorded.started_seconds
        && current.started_microseconds == recorded.started_microseconds
        && current.executable == recorded.executable
}

fn same_process_birth(current: &ProcessIdentity, recorded: &ProcessIdentity) -> bool {
    current.pid == recorded.pid
        && current.started_seconds == recorded.started_seconds
        && current.started_microseconds == recorded.started_microseconds
}

fn same_owned_process_instance(current: &ProcessIdentity, recorded: &ProcessIdentity) -> bool {
    same_process_birth(current, recorded)
        && current.process_group_id == recorded.process_group_id
        && current.session_id == recorded.session_id
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

fn refresh_record(path: &Path, record: &mut OwnershipRegistry) -> Result<(), AppError> {
    let processes = inspect_all_with_recorded(record)?;
    if !processes
        .iter()
        .any(|member| same_owned_process(member, &record.leader))
    {
        return quarantine(
            path,
            record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                "Sidecar 主进程已离开已登记进程组",
            ),
        );
    }
    let (mut groups, allowed_detached_transitions) =
        match discover_descendant_group_roots(record, &processes) {
            Ok(discovered) => discovered,
            Err(error) => return quarantine(path, record, error),
        };
    if let Some(conflict) =
        recorded_identity_conflict_excluding(record, &processes, &allowed_detached_transitions)
    {
        return quarantine(
            path,
            record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                format!("已登记的 Sidecar 子进程 {} 身份发生变化", conflict.pid),
            ),
        );
    }
    if let Some(reused) = reused_group_root(&groups, &processes) {
        return quarantine(
            path,
            record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                format!("owned process group {} 的 root identity 已复用", reused.pid),
            ),
        );
    }
    groups.retain(|root| {
        root.process_group_id == record.leader.process_group_id
            || group_exists(root.process_group_id as i32)
    });
    let owned_groups = groups
        .iter()
        .map(|root| root.process_group_id as i32)
        .collect::<HashSet<_>>();
    let mut current = processes
        .into_iter()
        .filter(|member| {
            owned_groups.contains(&(member.process_group_id as i32))
                && member.session_id == member.process_group_id as i32
        })
        .collect::<Vec<_>>();
    if !current
        .iter()
        .any(|member| same_owned_process(member, &record.leader))
    {
        return quarantine(
            path,
            record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                "Sidecar leader 在刷新 ownership registry 时消失",
            ),
        );
    }
    for root in &groups {
        if group_exists(root.process_group_id as i32)
            && !current
                .iter()
                .any(|member| member.process_group_id == root.process_group_id)
        {
            return quarantine(
                path,
                record,
                AppError::new(
                    ErrorCode::RuntimeStopFailed,
                    format!(
                        "owned process group {} 存活但无法枚举成员",
                        root.process_group_id
                    ),
                ),
            );
        }
    }
    current.sort_by_key(|member| member.pid);
    groups.sort_by_key(|root| root.process_group_id);
    record.groups = groups;
    record.members = current;
    record.generation = record.generation.saturating_add(1);
    write_registry(path, record, ErrorCode::RuntimeStopFailed)
}

fn verify_retryable_members(path: &Path, record: &mut OwnershipRegistry) -> Result<(), AppError> {
    verify_registered_groups(path, record).map(|_| ())
}

fn verify_registered_groups(
    path: &Path,
    record: &mut OwnershipRegistry,
) -> Result<Vec<i32>, AppError> {
    let processes = inspect_all_with_recorded(record)?;
    if recorded_identity_conflict(record, &processes).is_some() {
        return quarantine(
            path,
            record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                "ownership registry 中已登记进程的身份发生变化；拒绝误杀",
            ),
        );
    }
    let group_roots = normalized_group_roots(record);
    if let Some(reused) = reused_group_root(&group_roots, &processes) {
        return quarantine(
            path,
            record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                format!("owned process group {} 的 root identity 已复用", reused.pid),
            ),
        );
    }
    let registered_groups = group_roots
        .iter()
        .map(|root| root.process_group_id as i32)
        .collect::<HashSet<_>>();
    let group_is_unverifiable = registered_groups.iter().any(|group| {
        let current = processes
            .iter()
            .filter(|live| live.process_group_id == *group as u32 && live.session_id == *group)
            .collect::<Vec<_>>();
        group_exists(*group) && current.is_empty()
    });
    if group_is_unverifiable {
        return quarantine(
            path,
            record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                "已登记 Sidecar 子进程组存活但无法验证成员；拒绝误杀",
            ),
        );
    }
    record.groups = group_roots;
    record.members = processes
        .into_iter()
        .filter(|live| {
            registered_groups.contains(&(live.process_group_id as i32))
                && live.session_id == live.process_group_id as i32
        })
        .collect();
    write_registry(path, record, ErrorCode::RuntimeStopFailed)?;
    let mut live_groups = record
        .members
        .iter()
        .map(|member| member.process_group_id as i32)
        .collect::<Vec<_>>();
    live_groups.sort_unstable();
    live_groups.dedup();
    Ok(live_groups)
}

fn recorded_identity_conflict(
    record: &OwnershipRegistry,
    processes: &[ProcessIdentity],
) -> Option<ProcessIdentity> {
    recorded_identity_conflict_excluding(record, processes, &HashSet::new())
}

fn recorded_identity_conflict_excluding(
    record: &OwnershipRegistry,
    processes: &[ProcessIdentity],
    allowed_detached_transitions: &HashSet<u32>,
) -> Option<ProcessIdentity> {
    record.members.iter().find_map(|member| {
        processes
            .iter()
            .find(|live| live.pid == member.pid)
            .filter(|live| {
                same_process_birth(live, member)
                    && !same_owned_process_instance(live, member)
                    && !allowed_detached_transitions.contains(&live.pid)
            })
            .cloned()
    })
}

fn discover_descendant_group_roots(
    record: &OwnershipRegistry,
    processes: &[ProcessIdentity],
) -> Result<(Vec<ProcessIdentity>, HashSet<u32>), AppError> {
    let descendants = descendants_of(record.leader.pid, processes);
    let descendant_pids = descendants
        .iter()
        .map(|member| member.pid)
        .collect::<HashSet<_>>();
    let mut groups = normalized_group_roots(record);
    let mut allowed_detached_transitions = HashSet::new();
    for member in &descendants {
        if member.session_id != member.process_group_id as i32 {
            continue;
        }
        if groups
            .iter()
            .any(|root| root.process_group_id == member.process_group_id)
        {
            continue;
        }
        let Some(root) = processes.iter().find(|candidate| {
            candidate.pid == member.process_group_id
                && candidate.session_id == member.session_id
                && descendant_pids.contains(&candidate.pid)
        }) else {
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                format!(
                    "无法确认 detached group {} 的 ancestry root",
                    member.process_group_id
                ),
            ));
        };
        if record.members.iter().any(|recorded| {
            same_process_birth(root, recorded) && !same_owned_process_instance(root, recorded)
        }) {
            allowed_detached_transitions.insert(root.pid);
        }
        groups.push(root.clone());
    }
    Ok((groups, allowed_detached_transitions))
}

fn normalized_group_roots(record: &OwnershipRegistry) -> Vec<ProcessIdentity> {
    let mut roots = if record.groups.is_empty() {
        record
            .members
            .iter()
            .filter(|member| {
                member.pid == member.process_group_id
                    && member.session_id == member.process_group_id as i32
            })
            .cloned()
            .collect::<Vec<_>>()
    } else {
        record.groups.clone()
    };
    if !roots
        .iter()
        .any(|root| root.process_group_id == record.leader.process_group_id)
    {
        roots.push(record.leader.clone());
    }
    roots.sort_by_key(|root| root.process_group_id);
    roots.dedup_by_key(|root| root.process_group_id);
    roots
}

fn reused_group_root(
    roots: &[ProcessIdentity],
    processes: &[ProcessIdentity],
) -> Option<ProcessIdentity> {
    roots.iter().find_map(|root| {
        processes
            .iter()
            .find(|process| process.pid == root.process_group_id)
            .filter(|live| !same_owned_process_instance(live, root))
            .cloned()
    })
}

fn inspect_all_with_recorded(record: &OwnershipRegistry) -> Result<Vec<ProcessIdentity>, AppError> {
    let mut processes = inspect_all()?;
    let roots = normalized_group_roots(record);
    for member in record.members.iter().chain(roots.iter()) {
        if let Some(live) = inspect_recorded(member.pid)? {
            processes.retain(|process| process.pid != live.pid);
            processes.push(live);
        }
    }
    processes.sort_by_key(|process| process.pid);
    processes.dedup_by_key(|process| process.pid);
    Ok(processes)
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
    if record.leader.executable != expected {
        return quarantine(
            path,
            &mut record,
            AppError::new(
                ErrorCode::RuntimeStopFailed,
                "quarantine executable 不属于当前应用；拒绝误杀",
            ),
        );
    }
    if let Some(current) = inspect_recorded(record.leader.pid)? {
        if !same_owned_process(&current, &record.leader) {
            return quarantine(
                path,
                &mut record,
                AppError::new(
                    ErrorCode::RuntimeStopFailed,
                    "quarantine 主进程身份不匹配；拒绝误杀",
                ),
            );
        }
        verify_retryable_members(path, &mut record)?;
    } else {
        verify_registered_groups(path, &mut record)?;
    }
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
    mut child: Option<&mut Child>,
    deadline: Instant,
    abort_on_shutdown: Option<&AtomicBool>,
) -> Result<(), AppError> {
    let Some(mut record) = read_registry(path)? else {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "清理 Sidecar 进程组前缺少 ownership registry",
        ));
    };
    ensure_supported(&record)?;
    if record.state != RegistryState::Cleaning {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "ownership registry 尚未进入 cleaning 状态",
        ));
    }
    let groups = verify_registered_groups(path, &mut record)?;
    if groups.is_empty() {
        return Ok(());
    }
    let cleanup_deadline = deadline
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(Instant::now);
    for group in &groups {
        validate_group(*group)?;
        signal_group(*group, libc::SIGTERM)?;
    }
    if wait_for_groups(
        &mut child,
        &groups,
        cleanup_deadline.min(Instant::now() + Duration::from_secs(2)),
        abort_on_shutdown,
    )? {
        return verify_groups_absent(&groups, deadline);
    }
    for group in groups.iter().filter(|group| group_exists(**group)) {
        signal_group(*group, libc::SIGKILL)?;
    }
    if wait_for_groups(&mut child, &groups, cleanup_deadline, abort_on_shutdown)? {
        return verify_groups_absent(&groups, deadline);
    }
    Err(AppError::new(
        ErrorCode::RuntimeStopFailed,
        "已登记的 Sidecar 进程组在 5 秒后仍未退出",
    ))
}

fn wait_for_groups(
    child: &mut Option<&mut Child>,
    groups: &[i32],
    deadline: Instant,
    abort_on_shutdown: Option<&AtomicBool>,
) -> Result<bool, AppError> {
    while Instant::now() < deadline {
        if abort_on_shutdown.is_some_and(|intent| intent.load(Ordering::SeqCst)) {
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "旧 Runtime 恢复清理已交由退出流程接管",
            ));
        }
        if let Some(process) = child.as_deref_mut() {
            process.try_wait().map_err(runtime_stop_error)?;
        }
        if groups.iter().all(|group| !group_exists(*group)) {
            return Ok(true);
        }
        thread::sleep(Duration::from_millis(25));
    }
    Ok(false)
}

fn verify_groups_absent(groups: &[i32], deadline: Instant) -> Result<(), AppError> {
    let verification_deadline = Instant::now() + Duration::from_secs(1);
    if verification_deadline > deadline {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "进程树清理未给最终稳定验证保留 1 秒",
        ));
    }
    while Instant::now() < verification_deadline {
        if groups.iter().any(|group| group_exists(*group)) {
            return Err(AppError::new(
                ErrorCode::RuntimeStopFailed,
                "已清理的 Sidecar 进程组在最终验证窗口内重新出现",
            ));
        }
        thread::sleep(Duration::from_millis(25));
    }
    Ok(())
}

fn read_registry(path: &Path) -> Result<Option<OwnershipRegistry>, AppError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(runtime_stop_error(error)),
    };
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.permissions().mode() & 0o077 != 0
        || metadata.len() > 65_536
    {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "ownership registry 文件类型、权限或大小无效",
        ));
    }
    let bytes = fs::read(path).map_err(runtime_stop_error)?;
    if let Ok(registry) = serde_json::from_slice::<OwnershipRegistry>(&bytes) {
        return Ok(Some(registry));
    }
    let leader = serde_json::from_slice::<ProcessIdentity>(&bytes)
        .map_err(|error| AppError::new(ErrorCode::RuntimeStopFailed, error.to_string()))?;
    Ok(Some(OwnershipRegistry {
        schema_version: 1,
        instance_id: "legacy".into(),
        ownership_token: uuid::Uuid::new_v4().to_string(),
        generation: 0,
        state: RegistryState::Active,
        groups: vec![leader.clone()],
        members: vec![leader.clone()],
        leader,
    }))
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
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| AppError::new(error_code, error.to_string()))?;
        fs::rename(&temporary, path).map_err(|error| AppError::new(error_code, error.to_string()))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn inspect_group(pgid: i32) -> Result<Vec<ProcessIdentity>, AppError> {
    validate_group(pgid)?;
    group_members(&inspect_all()?, pgid)
}

fn group_members(
    processes: &[ProcessIdentity],
    pgid: i32,
) -> Result<Vec<ProcessIdentity>, AppError> {
    validate_group(pgid)?;
    let mut members = processes
        .iter()
        .filter(|identity| identity.process_group_id == pgid as u32 && identity.session_id == pgid)
        .cloned()
        .collect::<Vec<_>>();
    members.sort_by_key(|member| member.pid);
    Ok(members)
}

fn inspect_all() -> Result<Vec<ProcessIdentity>, AppError> {
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "无法枚举系统进程",
        ));
    }
    let mut pids = vec![0_i32; count as usize + 256];
    let listed = unsafe {
        libc::proc_listallpids(
            pids.as_mut_ptr().cast(),
            (pids.len() * size_of::<i32>()) as i32,
        )
    };
    if listed < 0 {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "无法读取系统进程列表",
        ));
    }
    let mut processes = Vec::new();
    for pid in pids
        .into_iter()
        .take(listed as usize)
        .filter(|pid| *pid > 0)
    {
        if let Some(identity) = inspect(pid as u32)? {
            processes.push(identity);
        }
    }
    processes.sort_by_key(|process| process.pid);
    Ok(processes)
}

fn descendants_of(root_pid: u32, processes: &[ProcessIdentity]) -> Vec<ProcessIdentity> {
    let by_pid = processes
        .iter()
        .map(|process| (process.pid, process))
        .collect::<HashMap<_, _>>();
    processes
        .iter()
        .filter(|process| {
            let mut parent_pid = process.parent_pid;
            let mut visited = HashSet::new();
            while parent_pid > 0 && visited.insert(parent_pid) {
                if parent_pid == root_pid {
                    return true;
                }
                let Some(parent) = by_pid.get(&parent_pid) else {
                    return false;
                };
                parent_pid = parent.parent_pid;
            }
            false
        })
        .cloned()
        .collect()
}

fn inspect(pid: u32) -> Result<Option<ProcessIdentity>, AppError> {
    let mut information: libc::proc_bsdinfo = unsafe { zeroed() };
    let information_size = size_of::<libc::proc_bsdinfo>() as i32;
    let read = unsafe {
        libc::proc_pidinfo(
            pid as i32,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut information as *mut libc::proc_bsdinfo).cast(),
            information_size,
        )
    };
    if read == 0 {
        return Ok(None);
    }
    if read != information_size {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "无法完整读取进程身份",
        ));
    }
    let mut buffer = vec![0_i8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let length =
        unsafe { libc::proc_pidpath(pid as i32, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if length <= 0 {
        return Ok(None);
    }
    let executable = unsafe { CStr::from_ptr(buffer.as_ptr()) }
        .to_str()
        .map_err(|_| AppError::new(ErrorCode::RuntimeStopFailed, "进程路径不是 UTF-8"))?;
    let session_id = unsafe { libc::getsid(pid as i32) };
    if session_id < 0 {
        return Ok(None);
    }
    Ok(Some(ProcessIdentity {
        pid: information.pbi_pid,
        parent_pid: information.pbi_ppid,
        process_group_id: information.pbi_pgid,
        session_id,
        started_seconds: information.pbi_start_tvsec,
        started_microseconds: information.pbi_start_tvusec,
        executable: PathBuf::from(executable),
    }))
}

fn inspect_recorded(pid: u32) -> Result<Option<ProcessIdentity>, AppError> {
    for _ in 0..3 {
        if let Some(identity) = inspect(pid)? {
            return Ok(Some(identity));
        }
        if !process_exists(pid) {
            return Ok(None);
        }
        thread::yield_now();
    }
    Err(AppError::new(
        ErrorCode::RuntimeStopFailed,
        format!("无法读取仍存活的已登记进程 {pid} 身份"),
    ))
}

fn process_exists(pid: u32) -> bool {
    let result = unsafe { libc::kill(pid as i32, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn validate_group(pgid: i32) -> Result<(), AppError> {
    if pgid <= 1 || pgid == unsafe { libc::getpgrp() } {
        return Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            "拒绝操作无效或当前进程组",
        ));
    }
    Ok(())
}

fn signal_group(pgid: i32, signal: i32) -> Result<(), AppError> {
    let result = unsafe { libc::kill(-pgid, signal) };
    let error = std::io::Error::last_os_error();
    if result == 0 || error.raw_os_error() == Some(libc::ESRCH) {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::RuntimeStopFailed,
            format!("无法向已登记进程组发送信号：{error}"),
        ))
    }
}

fn group_exists(pgid: i32) -> bool {
    let result = unsafe { libc::kill(-pgid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn runtime_stop_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::RuntimeStopFailed, error.to_string())
}

pub fn open_logs_directory(root: &Path, _: &AppHandle) -> Result<(), AppError> {
    fs::create_dir_all(root)
        .map_err(|error| AppError::new(ErrorCode::LogsUnavailable, error.to_string()))?;
    Command::new("/usr/bin/open")
        .arg(root)
        .spawn()
        .map(|_| ())
        .map_err(|error| AppError::new(ErrorCode::LogsUnavailable, error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        os::unix::process::CommandExt,
        process::Stdio,
    };

    struct TestProcessGuard {
        leader_pid: u32,
        identities: Vec<ProcessIdentity>,
    }

    impl TestProcessGuard {
        fn new(leader_pid: u32, identities: Vec<ProcessIdentity>) -> Self {
            Self {
                leader_pid,
                identities,
            }
        }
    }

    impl Drop for TestProcessGuard {
        fn drop(&mut self) {
            let mut killed_groups = HashSet::new();
            for identity in &self.identities {
                let Ok(Some(current)) = inspect_recorded(identity.pid) else {
                    continue;
                };
                if same_owned_process(&current, identity)
                    && killed_groups.insert(identity.process_group_id)
                {
                    let _ = signal_group(identity.process_group_id as i32, libc::SIGKILL);
                }
            }
            let deadline = Instant::now() + Duration::from_secs(1);
            while Instant::now() < deadline {
                let waited = unsafe {
                    libc::waitpid(self.leader_pid as i32, std::ptr::null_mut(), libc::WNOHANG)
                };
                if waited != 0 {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    #[test]
    fn refuses_system_and_current_groups() {
        assert!(validate_group(1).is_err());
        assert!(validate_group(unsafe { libc::getpgrp() }).is_err());
    }

    #[test]
    fn inspects_current_process_with_stable_start_time_and_path() {
        let identity = inspect(std::process::id()).unwrap().unwrap();
        assert_eq!(identity.pid, std::process::id());
        assert!(identity.started_seconds > 0);
        assert!(identity.executable.is_absolute());
    }

    #[test]
    fn migrates_legacy_single_process_registry() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("ownership.json");
        let identity = inspect(std::process::id()).unwrap().unwrap();
        fs::write(&path, serde_json::to_vec(&identity).unwrap()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let registry = read_registry(&path).unwrap().unwrap();
        assert_eq!(registry.schema_version, 1);
        assert_eq!(registry.instance_id, "legacy");
        assert_eq!(registry.members, vec![identity]);
    }

    #[test]
    fn quarantined_registry_is_retryable_only_by_recovery_path() {
        let identity = inspect(std::process::id()).unwrap().unwrap();
        let registry = OwnershipRegistry {
            schema_version: 1,
            instance_id: "test".into(),
            ownership_token: "test-token".into(),
            generation: 2,
            state: RegistryState::Quarantined,
            leader: identity.clone(),
            groups: vec![identity.clone()],
            members: vec![identity],
        };

        assert!(ensure_supported(&registry).is_ok());
        assert!(ensure_active(&registry).is_err());
    }

    #[test]
    fn ownership_match_rejects_every_identity_conflict() {
        let identity = inspect(std::process::id()).unwrap().unwrap();
        for changed in [
            ProcessIdentity {
                pid: identity.pid.saturating_add(1),
                ..identity.clone()
            },
            ProcessIdentity {
                process_group_id: identity.process_group_id.saturating_add(1),
                ..identity.clone()
            },
            ProcessIdentity {
                session_id: identity.session_id.saturating_add(1),
                ..identity.clone()
            },
            ProcessIdentity {
                started_microseconds: identity.started_microseconds.saturating_add(1),
                ..identity.clone()
            },
            ProcessIdentity {
                executable: PathBuf::from("/unexpected/executable"),
                ..identity.clone()
            },
        ] {
            assert!(!same_owned_process(&changed, &identity));
        }
    }

    #[test]
    fn descendant_scan_detects_process_outside_leader_session() {
        let mut leader = inspect(std::process::id()).unwrap().unwrap();
        leader.pid = 10_000;
        leader.parent_pid = 1;
        leader.process_group_id = 10_000;
        leader.session_id = 10_000;
        let child = ProcessIdentity {
            pid: 10_001,
            parent_pid: leader.pid,
            process_group_id: leader.process_group_id,
            session_id: leader.session_id,
            ..leader.clone()
        };
        let escaped = ProcessIdentity {
            pid: 10_002,
            parent_pid: child.pid,
            process_group_id: 10_002,
            session_id: 10_002,
            ..child.clone()
        };

        let descendants = descendants_of(leader.pid, &[leader.clone(), child, escaped.clone()]);
        assert_eq!(descendants.len(), 2);
        assert!(descendants.iter().any(|member| {
            member.pid == escaped.pid
                && (member.process_group_id != leader.process_group_id
                    || member.session_id != leader.session_id)
        }));
    }

    #[test]
    fn detached_owned_group_is_valid_but_later_identity_change_is_not() {
        let leader = inspect(std::process::id()).unwrap().unwrap();
        let detached = ProcessIdentity {
            pid: leader.pid.saturating_add(1),
            parent_pid: leader.pid,
            process_group_id: leader.process_group_id.saturating_add(1),
            session_id: leader.session_id.saturating_add(1),
            ..leader.clone()
        };
        let registry = OwnershipRegistry {
            schema_version: 1,
            instance_id: "test".into(),
            ownership_token: "test-token".into(),
            generation: 2,
            state: RegistryState::Active,
            leader: leader.clone(),
            groups: vec![leader.clone(), detached.clone()],
            members: vec![leader.clone(), detached.clone()],
        };

        assert!(
            recorded_identity_conflict(&registry, &[leader.clone(), detached.clone()]).is_none()
        );
        let moved = ProcessIdentity {
            process_group_id: detached.process_group_id.saturating_add(1),
            session_id: detached.session_id.saturating_add(1),
            ..detached
        };
        assert!(recorded_identity_conflict(&registry, &[leader, moved]).is_some());
    }

    #[test]
    fn host_group_child_transitioning_to_descendant_detached_root_is_allowed() {
        let mut leader = inspect(std::process::id()).unwrap().unwrap();
        leader.pid = 20_000;
        leader.parent_pid = 1;
        leader.process_group_id = leader.pid;
        leader.session_id = leader.pid as i32;
        let before_setsid = ProcessIdentity {
            pid: 20_001,
            parent_pid: leader.pid,
            process_group_id: leader.process_group_id,
            session_id: leader.session_id,
            ..leader.clone()
        };
        let after_setsid = ProcessIdentity {
            process_group_id: before_setsid.pid,
            session_id: before_setsid.pid as i32,
            ..before_setsid.clone()
        };
        let registry = OwnershipRegistry {
            schema_version: 1,
            instance_id: "setsid-transition-test".into(),
            ownership_token: "test-token".into(),
            generation: 2,
            state: RegistryState::Active,
            leader: leader.clone(),
            groups: vec![leader.clone()],
            members: vec![leader.clone(), before_setsid],
        };
        let processes = vec![leader, after_setsid.clone()];

        let (groups, allowed) = discover_descendant_group_roots(&registry, &processes).unwrap();

        assert!(groups.iter().any(|root| root.pid == after_setsid.pid));
        assert!(allowed.contains(&after_setsid.pid));
        assert!(recorded_identity_conflict_excluding(&registry, &processes, &allowed).is_none());
    }

    #[test]
    fn cleans_real_detached_child_group_registered_from_ancestry() {
        let node =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime/node/darwin-arm64/bin/node");
        assert!(node.is_file(), "测试前必须准备 bundled Node");
        let temporary = tempfile::tempdir().unwrap();
        let registry_path = temporary.path().join("ownership.json");
        let mut command = Command::new(&node);
        command
            .args([
                "-e",
                "const {spawn}=require('node:child_process');const c=spawn('/bin/sleep',['30'],{detached:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)",
            ])
            .stdout(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut leader = command.spawn().unwrap();
        let detached_pid: u32 = BufReader::new(leader.stdout.take().unwrap())
            .lines()
            .next()
            .unwrap()
            .unwrap()
            .parse()
            .unwrap();
        let leader_identity = inspect_recorded(leader.id()).unwrap().unwrap();
        let detached_identity = inspect_recorded(detached_pid).unwrap().unwrap();
        let _guard = TestProcessGuard::new(
            leader.id(),
            vec![leader_identity.clone(), detached_identity.clone()],
        );
        register(&registry_path, leader.id(), &node, "detached-test").unwrap();
        refresh_registered(&registry_path).unwrap();
        let record = read_registry(&registry_path).unwrap().unwrap();
        assert!(record.members.iter().any(|member| {
            member.pid == detached_pid
                && member.process_group_id == detached_pid
                && member.session_id == detached_pid as i32
        }));

        begin_cleanup(&registry_path).unwrap();
        terminate_registered(
            &registry_path,
            Some(&mut leader),
            Instant::now() + Duration::from_secs(5),
            None,
        )
        .unwrap();
        unregister(&registry_path).unwrap();
        assert!(!group_exists(leader_identity.process_group_id as i32));
        assert!(!group_exists(detached_pid as i32));
    }

    #[test]
    fn keeps_and_cleans_group_after_detached_root_exits() {
        let node =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime/node/darwin-arm64/bin/node");
        assert!(node.is_file(), "测试前必须准备 bundled Node");
        let temporary = tempfile::tempdir().unwrap();
        let registry_path = temporary.path().join("ownership.json");
        let mut command = Command::new(&node);
        command
            .args([
                "-e",
                "const {spawn}=require('node:child_process');const c=spawn('/bin/sh',['-c','sleep 30 & echo \"$$ $!\"; sleep 1'],{detached:true,stdio:['ignore','pipe','ignore']});c.stdout.once('data',d=>console.log(d.toString().trim()));setInterval(()=>{},1000)",
            ])
            .stdout(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut leader = command.spawn().unwrap();
        let line = BufReader::new(leader.stdout.take().unwrap())
            .lines()
            .next()
            .unwrap()
            .unwrap();
        let pids = line
            .split_whitespace()
            .map(|value| value.parse::<u32>().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(pids.len(), 2);
        let detached_root_pid = pids[0];
        let survivor_pid = pids[1];
        let leader_identity = inspect_recorded(leader.id()).unwrap().unwrap();
        let detached_root = inspect_recorded(detached_root_pid).unwrap().unwrap();
        let survivor = inspect_recorded(survivor_pid).unwrap().unwrap();
        let _guard = TestProcessGuard::new(
            leader.id(),
            vec![
                leader_identity.clone(),
                detached_root.clone(),
                survivor.clone(),
            ],
        );

        register(&registry_path, leader.id(), &node, "root-exit-test").unwrap();
        refresh_registered(&registry_path).unwrap();
        let wait_deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < wait_deadline && process_exists(detached_root_pid) {
            thread::sleep(Duration::from_millis(25));
        }
        assert!(!process_exists(detached_root_pid));
        assert!(process_exists(survivor_pid));
        assert!(group_exists(detached_root.process_group_id as i32));

        refresh_registered(&registry_path).unwrap();
        let record = read_registry(&registry_path).unwrap().unwrap();
        assert!(record.groups.iter().any(|root| {
            root.pid == detached_root.pid
                && root.process_group_id == detached_root.process_group_id
                && root.started_seconds == detached_root.started_seconds
                && root.started_microseconds == detached_root.started_microseconds
        }));
        assert!(record
            .members
            .iter()
            .any(|member| member.pid == survivor_pid));

        begin_cleanup(&registry_path).unwrap();
        terminate_registered(
            &registry_path,
            Some(&mut leader),
            Instant::now() + Duration::from_secs(5),
            None,
        )
        .unwrap();
        unregister(&registry_path).unwrap();
        assert!(!group_exists(leader_identity.process_group_id as i32));
        assert!(!group_exists(detached_root.process_group_id as i32));
    }

    #[test]
    fn registry_write_failure_cleans_leader_and_detached_group() {
        let node =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../runtime/node/darwin-arm64/bin/node");
        assert!(node.is_file(), "测试前必须准备 bundled Node");
        let temporary = tempfile::tempdir().unwrap();
        let registry_path = temporary.path().join("ownership-target");
        fs::create_dir(&registry_path).unwrap();
        let mut command = Command::new(&node);
        command
            .args([
                "-e",
                "const {spawn}=require('node:child_process');const c=spawn('/bin/sleep',['30'],{detached:true,stdio:'ignore'});console.log(c.pid);setInterval(()=>{},1000)",
            ])
            .stdout(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut leader = command.spawn().unwrap();
        let detached_pid = BufReader::new(leader.stdout.take().unwrap())
            .lines()
            .next()
            .unwrap()
            .unwrap()
            .parse::<u32>()
            .unwrap();
        let leader_identity = inspect_recorded(leader.id()).unwrap().unwrap();
        let detached_identity = inspect_recorded(detached_pid).unwrap().unwrap();
        let _guard = TestProcessGuard::new(
            leader.id(),
            vec![leader_identity.clone(), detached_identity.clone()],
        );

        assert!(register(&registry_path, leader.id(), &node, "write-failure-test").is_err());
        terminate_unregistered_spawn(
            &registry_path,
            &mut leader,
            leader_identity.pid,
            &node,
            "write-failure-test",
            Instant::now() + Duration::from_secs(5),
        )
        .unwrap();
        assert!(!group_exists(leader_identity.process_group_id as i32));
        assert!(!group_exists(detached_identity.process_group_id as i32));
        assert!(fs::read_dir(temporary.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".tmp")));
    }

    #[test]
    fn expired_registration_cleanup_deadline_never_reports_empty_success() {
        let executable = fs::canonicalize("/bin/sleep").unwrap();
        let mut command = Command::new(&executable);
        command.arg("30");
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut leader = command.spawn().unwrap();
        let identity = inspect_recorded(leader.id()).unwrap().unwrap();
        let _guard = TestProcessGuard::new(leader.id(), vec![identity.clone()]);
        let temporary = tempfile::tempdir().unwrap();
        let result = terminate_unregistered_spawn(
            &temporary.path().join("ownership.json"),
            &mut leader,
            identity.pid,
            &executable,
            "expired-deadline-test",
            Instant::now() + Duration::from_millis(100),
        );

        assert!(result.is_err());
        let exit_deadline = Instant::now() + Duration::from_secs(1);
        while Instant::now() < exit_deadline && group_exists(identity.process_group_id as i32) {
            let _ = leader.try_wait();
            thread::sleep(Duration::from_millis(10));
        }
        assert!(!group_exists(identity.process_group_id as i32));
    }

    #[test]
    fn child_handle_fallback_reaps_leader_without_process_identity() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let pid = child.id();

        kill_and_reap_spawned_child(&mut child).unwrap();

        assert!(child.try_wait().unwrap().is_some());
        assert!(!process_exists(pid));
    }

    #[test]
    fn mismatched_registration_identity_still_reaps_trusted_child() {
        let executable = fs::canonicalize("/bin/sleep").unwrap();
        let mut command = Command::new(&executable);
        command.arg("30");
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut child = command.spawn().unwrap();
        let pid = child.id();

        let result = terminate_unregistered_spawn(
            &tempfile::tempdir().unwrap().path().join("ownership.json"),
            &mut child,
            pid,
            Path::new("/bin/sh"),
            "mismatch-test",
            Instant::now() + Duration::from_secs(5),
        );

        assert!(result.is_err());
        assert!(child.try_wait().unwrap().is_some());
        assert!(!process_exists(pid));
    }

    #[test]
    fn quarantine_persists_private_retry_record() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("ownership.json");
        let identity = inspect(std::process::id()).unwrap().unwrap();
        let mut registry = OwnershipRegistry {
            schema_version: 1,
            instance_id: "test".into(),
            ownership_token: "test-token".into(),
            generation: 3,
            state: RegistryState::Active,
            leader: identity.clone(),
            groups: vec![identity.clone()],
            members: vec![identity],
        };

        assert!(quarantine::<()>(
            &path,
            &mut registry,
            AppError::new(ErrorCode::RuntimeStopFailed, "injected identity conflict")
        )
        .is_err());
        let persisted = read_registry(&path).unwrap().unwrap();
        assert_eq!(persisted.state, RegistryState::Quarantined);
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn forged_registry_never_signals_unrelated_process() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("ownership.json");
        let mut command = Command::new("/bin/sleep");
        command.arg("5");
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut child = command.spawn().unwrap();
        let identity = inspect(child.id()).unwrap().unwrap();
        let registry = OwnershipRegistry {
            schema_version: 1,
            instance_id: "forged".into(),
            ownership_token: "forged-token".into(),
            generation: 1,
            state: RegistryState::Active,
            leader: identity.clone(),
            groups: vec![identity.clone()],
            members: vec![identity],
        };
        write_registry(&path, &registry, ErrorCode::RuntimeStopFailed).unwrap();

        assert!(recover_registered(
            &path,
            Path::new("/bin/sh"),
            Instant::now() + Duration::from_secs(2),
            None,
        )
        .is_err());
        assert!(child.try_wait().unwrap().is_none());
        assert_eq!(
            read_registry(&path).unwrap().unwrap().state,
            RegistryState::Quarantined
        );

        child.kill().unwrap();
        child.wait().unwrap();
    }
}
