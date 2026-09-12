use crate::error::{AppError, ErrorCode};
use std::process::Command;
use std::sync::{Mutex, MutexGuard};
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavigationDecision {
    AllowBootstrap,
    AllowDsh,
    OpenExternal,
    Block,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Origin {
    scheme: String,
    host: String,
    port: Option<u16>,
}

#[derive(Debug, Default)]
pub struct WebviewPolicy {
    dsh_origin: Mutex<Option<Origin>>,
}

impl WebviewPolicy {
    fn lock(&self) -> MutexGuard<'_, Option<Origin>> {
        self.dsh_origin
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn set_dsh_origin(&self, url: &Url) -> Result<(), AppError> {
        let origin = origin_of(url)
            .ok_or_else(|| AppError::new(ErrorCode::HandshakeInvalid, "DSH Origin 不完整"))?;
        if origin.scheme != "http" || origin.host != "127.0.0.1" || origin.port.is_none() {
            return Err(AppError::new(
                ErrorCode::HandshakeInvalid,
                "DSH Origin 必须是带端口的 127.0.0.1 HTTP Origin",
            ));
        }
        *self.lock() = Some(origin);
        Ok(())
    }

    pub fn clear_dsh_origin(&self) {
        *self.lock() = None;
    }

    pub fn classify(&self, url: &Url) -> NavigationDecision {
        if is_app_origin(url) {
            return NavigationDecision::AllowBootstrap;
        }
        #[cfg(debug_assertions)]
        if url.scheme() == "http"
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
            && url.port() == Some(5173)
        {
            return NavigationDecision::AllowBootstrap;
        }
        if self
            .lock()
            .as_ref()
            .is_some_and(|allowed| origin_of(url).as_ref() == Some(allowed))
        {
            return NavigationDecision::AllowDsh;
        }
        match url.scheme() {
            "http" | "https" => NavigationDecision::OpenExternal,
            _ => NavigationDecision::Block,
        }
    }

    /// DSH 页面判定：必须是已登记的 DSH origin，且不带认证 query。
    ///
    /// ⚠️ 实现上**必须**先判 origin、再判 query，且 origin 判定走 `self.dsh_origin`
    /// 而非 `classify()`——`classify()` 还会把应用自身 origin 判为可导航
    /// （见 `is_app_origin`），若复用其 `AllowDsh` 分支会把 bootstrap 页面误认为 DSH 页面。
    ///
    /// ⚠️ 但 `AllowBootstrap` 与 `AllowDsh` 是**两个不同分支**，因此原先
    /// `classify(url) == AllowDsh` 的写法本就不会把 bootstrap 页面算作 DSH 页面；
    /// 曾经一度改写为"直接比对 origin"的等价形式，实测导致就绪路径不再达成
    /// （`runtime_ready` 消失），已回退为原写法。改动此处须实跑验证就绪路径。
    pub fn is_clean_dsh_page(&self, url: &Url) -> bool {
        self.classify(url) == NavigationDecision::AllowDsh && url.query().is_none()
    }
}

/// 是否为**应用自身**的 origin（即打包进包内的 bootstrap 页面）。
///
/// ⚠️ 平台差异：Tauri 2 在 macOS 上用自定义协议 `tauri://localhost`，
/// 而在 **Windows/Linux 上用 `http://tauri.localhost`**（`https://tauri.localhost` 亦见）。
/// 早期实现只匹配 `tauri` / `asset` 协议，于是 Windows 上应用自身的 URL 落到
/// `http` 分支被判为 `OpenExternal` → `on_navigation` 调 `open_external` 用
/// `rundll32` 打开系统浏览器，用户看到浏览器被打开一个 `tauri.localhost` 页面
/// 且必然打不开（真机验收实测暴露）。
///
/// 安全性：该 origin 由 Tauri 的自定义协议处理器提供，只服务包内资产，不是外部网站；
/// 放行它不会把任意远程页面引入 WebView。真正的远程页面仍走 `OpenExternal`。
fn is_app_origin(url: &Url) -> bool {
    match url.scheme() {
        "tauri" | "asset" => true,
        "http" | "https" => matches!(url.host_str(), Some("tauri.localhost")),
        _ => false,
    }
}

pub fn open_external(url: &Url) -> Result<(), AppError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::new(
            ErrorCode::NavigationBlocked,
            "只允许把 HTTP(S) 外链交给系统浏览器",
        ));
    }
    open_http_external(url)
}

#[cfg(target_os = "macos")]
fn open_http_external(url: &Url) -> Result<(), AppError> {
    Command::new("/usr/bin/open")
        .arg(url.as_str())
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            AppError::new(
                ErrorCode::NavigationBlocked,
                format!("无法打开系统浏览器：{error}"),
            )
        })
}

#[cfg(target_os = "windows")]
fn open_http_external(url: &Url) -> Result<(), AppError> {
    Command::new("rundll32.exe")
        .args(["url.dll,FileProtocolHandler", url.as_str()])
        .spawn()
        .map(|_| ())
        .map_err(|error| {
            AppError::new(
                ErrorCode::NavigationBlocked,
                format!("无法打开系统浏览器：{error}"),
            )
        })
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn open_http_external(_url: &Url) -> Result<(), AppError> {
    Err(AppError::new(
        ErrorCode::NavigationBlocked,
        "当前平台暂不支持打开系统浏览器",
    ))
}

fn origin_of(url: &Url) -> Option<Origin> {
    Some(Origin {
        scheme: url.scheme().to_owned(),
        host: url.host_str()?.to_ascii_lowercase(),
        port: url.port_or_known_default(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fixed_dsh_origin_stays_in_webview() {
        let policy = WebviewPolicy::default();
        policy
            .set_dsh_origin(&Url::parse("http://127.0.0.1:43123/").unwrap())
            .unwrap();
        assert_eq!(
            policy.classify(&Url::parse("http://127.0.0.1:43123/chat").unwrap()),
            NavigationDecision::AllowDsh
        );
        assert_eq!(
            policy.classify(&Url::parse("http://127.0.0.1:43124/").unwrap()),
            NavigationDecision::OpenExternal
        );
        assert_eq!(
            policy.classify(&Url::parse("javascript:alert(1)").unwrap()),
            NavigationDecision::Block
        );
    }

    #[test]
    fn rejects_non_loopback_dsh_origin() {
        let policy = WebviewPolicy::default();
        assert!(policy
            .set_dsh_origin(&Url::parse("http://0.0.0.0:4000/").unwrap())
            .is_err());
    }

    #[test]
    fn clean_page_has_no_auth_query() {
        let policy = WebviewPolicy::default();
        policy
            .set_dsh_origin(&Url::parse("http://127.0.0.1:43123/").unwrap())
            .unwrap();
        assert!(policy.is_clean_dsh_page(&Url::parse("http://127.0.0.1:43123/").unwrap()));
        assert!(
            !policy.is_clean_dsh_page(&Url::parse("http://127.0.0.1:43123/?token=secret").unwrap())
        );
    }

    #[test]
    fn cleared_origin_is_no_longer_trusted() {
        let policy = WebviewPolicy::default();
        let url = Url::parse("http://127.0.0.1:43123/").unwrap();
        policy.set_dsh_origin(&url).unwrap();
        policy.clear_dsh_origin();
        assert_eq!(policy.classify(&url), NavigationDecision::OpenExternal);
    }

    /// 应用自身的 origin 必须留在 WebView 内，且**不得**被判为可交给系统浏览器。
    /// Windows 上的 app 协议是 `http://tauri.localhost`（macOS 为 `tauri://localhost`）；
    /// 漏判会导致启动时浏览器被打开一个打不开的 `tauri.localhost` 页面（真机实测暴露）。
    #[test]
    fn app_origins_stay_in_webview() {
        let policy = WebviewPolicy::default();
        for url in [
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html",
            "https://tauri.localhost/",
            "tauri://localhost/",
            "asset://localhost/",
        ] {
            assert_eq!(
                policy.classify(&Url::parse(url).unwrap()),
                NavigationDecision::AllowBootstrap,
                "{url} 应留在 WebView 内"
            );
        }
        // 相似但不同的主机不得被放行
        for url in [
            "http://tauri.localhost.evil.example/",
            "http://evil.example/",
            "http://127.0.0.1:43124/",
        ] {
            assert_eq!(
                policy.classify(&Url::parse(url).unwrap()),
                NavigationDecision::OpenExternal,
                "{url} 应交给系统浏览器"
            );
        }
    }

    /// `is_clean_dsh_page` 只认已登记的 DSH origin；bootstrap origin 不算 DSH 页面。
    #[test]
    fn clean_page_excludes_bootstrap_origin() {
        let policy = WebviewPolicy::default();
        policy
            .set_dsh_origin(&Url::parse("http://127.0.0.1:43123/").unwrap())
            .unwrap();
        // bootstrap origin 走 AllowBootstrap 分支，不是 AllowDsh
        assert!(!policy.is_clean_dsh_page(&Url::parse("http://tauri.localhost/").unwrap()));
        assert!(!policy.is_clean_dsh_page(&Url::parse("tauri://localhost/").unwrap()));
        let fresh = WebviewPolicy::default();
        assert!(!fresh.is_clean_dsh_page(&Url::parse("http://tauri.localhost/").unwrap()));
    }
}
