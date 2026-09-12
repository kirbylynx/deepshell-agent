use crate::error::ErrorCode;
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuditEvent<'a> {
    timestamp_ms: u128,
    level: &'a str,
    event: &'a str,
    app_version: &'static str,
    node_version: &'static str,
    dsh_version: &'static str,
    sidecar_instance_id: Option<&'a str>,
    error_code: Option<String>,
    /// 失败原因的文字说明。
    ///
    /// 只允许写入**本应用自己构造**的消息（`AppError` 的 message 与固定的进程退出说明），
    /// 以及**已脱敏**的 sidecar stderr 摘要——不得写入凭据、token、URL query 或绝对用户路径。
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<&'a str>,
}

pub fn record(
    logs: &Path,
    level: &str,
    event: &str,
    error_code: Option<ErrorCode>,
) -> std::io::Result<()> {
    record_with_instance(logs, level, event, error_code, None)
}

pub fn record_with_instance(
    logs: &Path,
    level: &str,
    event: &str,
    error_code: Option<ErrorCode>,
    sidecar_instance_id: Option<&str>,
) -> std::io::Result<()> {
    record_detailed(logs, level, event, error_code, sidecar_instance_id, None)
}

pub fn record_detailed(
    logs: &Path,
    level: &str,
    event: &str,
    error_code: Option<ErrorCode>,
    sidecar_instance_id: Option<&str>,
    detail: Option<&str>,
) -> std::io::Result<()> {
    fs::create_dir_all(logs)?;
    set_private_directory_permissions(logs)?;
    let path = logs.join("app.jsonl");
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    set_private_file_permissions(&path)?;
    let redacted = detail.map(redact_detail);
    let payload = AuditEvent {
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        level,
        event,
        app_version: env!("CARGO_PKG_VERSION"),
        node_version: "24.20.0",
        dsh_version: "0.1.5-rc.1",
        sidecar_instance_id,
        error_code: error_code.map(|code| code.to_string()),
        detail: redacted.as_deref(),
    };
    serde_json::to_writer(&mut file, &payload)?;
    file.write_all(b"\n")?;
    file.flush()
}

/// 对写入日志的说明文字做最小必要脱敏：
/// 抹掉形如 `token=…` 的凭据片段，以及 `?token=…` 形式的 URL query。
/// 其余内容保留——它正是排查失败所需的信息。
fn redact_detail(detail: &str) -> String {
    let mut output = String::with_capacity(detail.len());
    for (index, token) in detail.split_whitespace().enumerate() {
        if index > 0 {
            output.push(' ');
        }
        if token.starts_with("token=") || token.contains("?token=") {
            output.push_str("[redacted-token]");
        } else {
            output.push_str(token);
        }
    }
    output
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn set_private_file_permissions(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_file_permissions(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_allowlisted_fields_with_private_permissions() {
        let temporary = tempfile::tempdir().unwrap();
        record(
            temporary.path(),
            "error",
            "runtime_failed",
            Some(ErrorCode::RuntimeStartFailed),
        )
        .unwrap();
        let path = temporary.path().join("app.jsonl");
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"appVersion\":\"0.1.3\""));
        assert!(text.contains("\"errorCode\":\"runtime_start_failed\""));
        #[cfg(unix)]
        assert_eq!(
            {
                use std::os::unix::fs::PermissionsExt;
                fs::metadata(path).unwrap().permissions().mode() & 0o777
            },
            0o600
        );
    }
}
