use crate::error::ErrorCode;
use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
    sync::OnceLock,
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
    let versions = runtime_versions();
    let payload = AuditEvent {
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis(),
        level,
        event,
        app_version: env!("CARGO_PKG_VERSION"),
        node_version: versions.node,
        dsh_version: versions.dsh,
        sidecar_instance_id,
        error_code: error_code.map(|code| code.to_string()),
        detail: redacted.as_deref(),
    };
    serde_json::to_writer(&mut file, &payload)?;
    file.write_all(b"\n")?;
    file.flush()
}

/// 运行时版本从 `runtime-lock.json` 注入（与菜单 About 同一来源），
/// 避免 Node/DSH 升级后审计日志仍谎报旧版本（此前是硬编码字面量）。
struct RuntimeVersions {
    node: &'static str,
    dsh: &'static str,
}

fn runtime_versions() -> &'static RuntimeVersions {
    static VERSIONS: OnceLock<RuntimeVersions> = OnceLock::new();
    VERSIONS.get_or_init(|| {
        let lock: serde_json::Value =
            serde_json::from_str(include_str!("../../runtime/manifest/runtime-lock.json"))
                .expect("runtime-lock.json 必须可解析");
        let version = |key: &str| {
            lock.get(key)
                .and_then(|value| value.get("version"))
                .and_then(|value| value.as_str())
                .unwrap_or("unknown")
        };
        // 版本字符串只在首次写入日志时泄漏一次（两个短字符串），换取 `&'static str`
        // 与 `AuditEvent` 借用结构、`OnceLock` 之间的零生命周期复杂度。
        RuntimeVersions {
            node: Box::leak(version("node").to_owned().into_boxed_str()),
            dsh: Box::leak(version("dsh").to_owned().into_boxed_str()),
        }
    })
}

/// 对写入日志的说明文字做最小必要脱敏：
/// 抹掉形如 `token=…`、`--token=…` 的凭据片段，以及 `?token=…` 形式的 URL query。
/// 其余内容保留——它正是排查失败所需的信息。
pub(crate) fn redact_detail(detail: &str) -> String {
    let mut output = String::with_capacity(detail.len());
    for (index, token) in detail.split_whitespace().enumerate() {
        if index > 0 {
            output.push(' ');
        }
        if is_token_fragment(token) {
            output.push_str("[redacted-token]");
        } else {
            output.push_str(token);
        }
    }
    output
}

fn is_token_fragment(token: &str) -> bool {
    token.starts_with("token=") || token.starts_with("--token=") || token.contains("?token=")
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
        assert!(text.contains("\"appVersion\":\"0.1.4\""));
        assert!(text.contains("\"errorCode\":\"runtime_start_failed\""));
        // 运行时版本必须与 runtime-lock 一致（防止 Node/DSH 升级后日志谎报版本）。
        let lock: serde_json::Value =
            serde_json::from_str(include_str!("../../runtime/manifest/runtime-lock.json")).unwrap();
        assert!(text.contains(&format!(
            "\"nodeVersion\":\"{}\"",
            lock["node"]["version"].as_str().unwrap()
        )));
        assert!(text.contains(&format!(
            "\"dshVersion\":\"{}\"",
            lock["dsh"]["version"].as_str().unwrap()
        )));
        #[cfg(unix)]
        assert_eq!(
            {
                use std::os::unix::fs::PermissionsExt;
                fs::metadata(path).unwrap().permissions().mode() & 0o777
            },
            0o600
        );
    }

    #[test]
    fn redacts_token_fragments_in_details() {
        assert_eq!(redact_detail("plain detail"), "plain detail");
        assert_eq!(
            redact_detail("request http://127.0.0.1:1/?token=abc"),
            "request [redacted-token]"
        );
        assert_eq!(redact_detail("flag --token=abc"), "flag [redacted-token]");
        assert_eq!(redact_detail("token=abc"), "[redacted-token]");
    }
}
