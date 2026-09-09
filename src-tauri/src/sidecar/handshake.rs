use crate::error::{AppError, ErrorCode};
use serde::Deserialize;
use std::{fs, path::Path};
use url::Url;
use zeroize::Zeroizing;

pub struct AuthUrl {
    secret: Zeroizing<String>,
    port: u16,
}

impl AuthUrl {
    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn expose(&self) -> Result<Url, AppError> {
        Url::parse(&self.secret)
            .map_err(|_| AppError::new(ErrorCode::HandshakeInvalid, "认证 URL 已失效"))
    }
}

pub fn parse(line: &str) -> Result<Option<AuthUrl>, AppError> {
    let Some((_, remainder)) = line.split_once("dsh web:") else {
        return Ok(None);
    };
    let candidate = remainder
        .split_whitespace()
        .next()
        .ok_or_else(|| AppError::new(ErrorCode::HandshakeInvalid, "DSH URL 缺失"))?;
    let url = Url::parse(candidate)
        .map_err(|_| AppError::new(ErrorCode::HandshakeInvalid, "DSH URL 无效"))?;
    let port = url
        .port()
        .filter(|port| *port > 0)
        .ok_or_else(|| AppError::new(ErrorCode::HandshakeInvalid, "DSH URL 缺少动态端口"))?;
    let query: Vec<_> = url.query_pairs().collect();
    let valid_token = query.len() == 1 && query[0].0 == "token" && !query[0].1.is_empty();
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.path() != "/"
        || url.fragment().is_some()
        || !valid_token
    {
        return Err(AppError::new(
            ErrorCode::HandshakeInvalid,
            "DSH URL 不符合 loopback process-token 契约",
        ));
    }
    Ok(Some(AuthUrl {
        secret: Zeroizing::new(candidate.to_owned()),
        port,
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadyPayload {
    instance_id: String,
    baseline: String,
    pid: u32,
    host: String,
    port: u16,
}

pub fn ready_file(path: &Path, instance_id: &str, pid: u32, port: u16) -> Result<bool, AppError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(AppError::new(
                ErrorCode::HandshakeInvalid,
                format!("无法检查 Client Ready 文件：{error}"),
            ))
        }
    };
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || !ready_file_is_private(&metadata)
        || metadata.len() > 4096
    {
        return Err(AppError::new(
            ErrorCode::HandshakeInvalid,
            "Client Ready 文件类型、权限或大小无效",
        ));
    }
    let payload: ReadyPayload = serde_json::from_slice(&fs::read(path).map_err(|error| {
        AppError::new(
            ErrorCode::HandshakeInvalid,
            format!("无法读取 Client Ready 文件：{error}"),
        )
    })?)
    .map_err(|_| AppError::new(ErrorCode::HandshakeInvalid, "Client Ready JSON 无效"))?;
    if payload.instance_id != instance_id
        || payload.baseline != "ready"
        || payload.pid != pid
        || payload.host != "127.0.0.1"
        || payload.port != port
    {
        return Err(AppError::new(
            ErrorCode::HandshakeInvalid,
            "Client Ready 与当前 Runtime 实例不匹配",
        ));
    }
    fs::remove_file(path).map_err(|error| {
        AppError::new(
            ErrorCode::HandshakeInvalid,
            format!("无法销毁 Client Ready 文件：{error}"),
        )
    })?;
    Ok(true)
}

#[cfg(unix)]
fn ready_file_is_private(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o077 == 0
}

#[cfg(not(unix))]
fn ready_file_is_private(_metadata: &fs::Metadata) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_exact_loopback_token_url() {
        let auth = parse("info dsh web: http://127.0.0.1:43123/?token=secret-value")
            .unwrap()
            .unwrap();
        assert_eq!(auth.port(), 43123);
        assert!(parse("dsh web: http://localhost:43123/?token=secret").is_err());
        assert!(parse("ordinary log line").unwrap().is_none());
    }

    #[test]
    fn accepts_and_consumes_instance_bound_ready_file() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("ready.json");
        fs::write(
            &path,
            r#"{"instanceId":"instance-1","baseline":"ready","pid":42,"host":"127.0.0.1","port":43123}"#,
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        assert!(ready_file(&path, "instance-1", 42, 43123).unwrap());
        assert!(!path.exists());
    }
}
