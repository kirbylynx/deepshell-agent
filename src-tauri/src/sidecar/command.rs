use crate::{
    error::{AppError, ErrorCode},
    paths::AppPaths,
};
use std::{
    collections::BTreeMap,
    ffi::OsString,
    process::{Command, Stdio},
};

fn controlled_environment(
    paths: &AppPaths,
    instance_id: &str,
) -> Result<BTreeMap<OsString, OsString>, AppError> {
    let mut environment = BTreeMap::new();
    for key in [
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "SSL_CERT_FILE",
        "SystemRoot",
        "WINDIR",
        "ComSpec",
        "PATHEXT",
        "TEMP",
        "TMP",
        "USERPROFILE",
    ] {
        if let Some(value) = std::env::var_os(key) {
            environment.insert(key.into(), value);
        }
    }
    let node_directory = paths
        .node
        .parent()
        .ok_or_else(|| AppError::new(ErrorCode::RuntimeUnavailable, "Node 路径缺少父目录"))?;
    let inherited_path = std::env::var_os("PATH")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| fallback_system_path().into());
    environment.insert(
        "PATH".into(),
        format!(
            "{}{}{}",
            node_directory.display(),
            path_separator(),
            inherited_path.to_string_lossy()
        )
        .into(),
    );
    for (key, value) in [
        ("HOME", paths.process_home.as_os_str()),
        ("DSH_HOME", paths.dsh_home.as_os_str()),
        ("DSH_DESKTOP_READY_FILE", paths.ready_file.as_os_str()),
    ] {
        environment.insert(key.into(), value.to_owned());
    }
    for (key, value) in [
        ("DSH_PERMISSION_MODE", "workspace-write"),
        ("DSH_TELEMETRY_MODE", "DISABLED"),
        ("DSH_TELEMETRY_DISABLED", "1"),
        ("DSH_CLIENT_TITLE", "DeepShell Agent"),
        ("DSH_DESKTOP_INSTANCE_ID", instance_id),
    ] {
        environment.insert(key.into(), value.into());
    }
    Ok(environment)
}

pub fn build(paths: &AppPaths, instance_id: &str) -> Result<Command, AppError> {
    paths.prepare()?;
    let mut command = Command::new(&paths.node);
    command
        .arg(&paths.dsh_entry)
        .args(["web", "--no-open", "--host", "127.0.0.1", "--port", "0"])
        .current_dir(&paths.workspace)
        .env_clear()
        .envs(controlled_environment(paths, instance_id)?)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    configure_process_group(&mut command);
    Ok(command)
}

#[cfg(unix)]
fn path_separator() -> &'static str {
    ":"
}

#[cfg(windows)]
fn path_separator() -> &'static str {
    ";"
}

#[cfg(unix)]
fn fallback_system_path() -> &'static str {
    "/usr/bin:/bin:/usr/sbin:/sbin"
}

#[cfg(windows)]
fn fallback_system_path() -> &'static str {
    r"C:\Windows\System32;C:\Windows;C:\Windows\System32\WindowsPowerShell\v1.0"
}

#[cfg(unix)]
fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
}

#[cfg(windows)]
fn configure_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    // `CREATE_NO_WINDOW` 是必需的：sidecar 是**控制台程序**（node.exe），
    // 而本应用是 GUI 子系统（`windows_subsystem = "windows"`、无控制台）。
    // 仅设 `CREATE_NEW_PROCESS_GROUP` 时，Windows 会为子进程**新建一个可见的控制台窗口**——
    // 由于 stdout/stderr 已被管道接管，用户看到的就是一个**空白命令行窗口**
    // （本机 Windows 真机验收实测暴露）。
    // `CREATE_NO_WINDOW` 让子进程仍拥有自己的控制台（但不显示），
    // 因此 stdout/stderr 管道与进程组语义**均不受影响**。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn environment_does_not_inherit_dsh_or_api_key_controls() {
        let temporary = tempfile::tempdir().unwrap();
        let paths = AppPaths::new(
            temporary.path().join("data"),
            temporary.path().join("resources"),
        )
        .unwrap();
        let environment = controlled_environment(&paths, "instance-1").unwrap();
        assert_eq!(
            environment.get(&OsString::from("DSH_PERMISSION_MODE")),
            Some(&OsString::from("workspace-write"))
        );
        assert_eq!(
            environment.get(&OsString::from("DSH_TELEMETRY_MODE")),
            Some(&OsString::from("DISABLED"))
        );
        assert!(!environment.contains_key(&OsString::from("DEEPSEEK_API_KEY")));
        assert!(!environment.contains_key(&OsString::from("DSH_TOOLS_MODE")));
    }
}
