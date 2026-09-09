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
        if matches!(url.scheme(), "tauri" | "asset") {
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

    pub fn is_clean_dsh_page(&self, url: &Url) -> bool {
        self.classify(url) == NavigationDecision::AllowDsh && url.query().is_none()
    }
}

pub fn open_external(url: &Url) -> Result<(), AppError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::new(
            ErrorCode::NavigationBlocked,
            "只允许把 HTTP(S) 外链交给系统浏览器",
        ));
    }
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
}
