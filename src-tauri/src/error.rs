use serde::{Deserialize, Serialize};
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ErrorCode {
    HandshakeInvalid,
    NavigationBlocked,
    RuntimeUnavailable,
    RuntimeStartFailed,
    RuntimeStopFailed,
    LogsUnavailable,
}

impl Display for ErrorCode {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        let value = match self {
            Self::HandshakeInvalid => "handshake_invalid",
            Self::NavigationBlocked => "navigation_blocked",
            Self::RuntimeUnavailable => "runtime_unavailable",
            Self::RuntimeStartFailed => "runtime_start_failed",
            Self::RuntimeStopFailed => "runtime_stop_failed",
            Self::LogsUnavailable => "logs_unavailable",
        };
        write!(f, "{value}")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppError {
    code: ErrorCode,
    message: String,
}

impl AppError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> ErrorCode {
        self.code
    }

    pub fn user_message(&self) -> &'static str {
        match self.code {
            ErrorCode::HandshakeInvalid => "DSH 认证握手失败，请重启 Runtime",
            ErrorCode::NavigationBlocked => "页面导航被安全策略拦截",
            ErrorCode::RuntimeUnavailable => "DeepShell Runtime 当前不可用",
            ErrorCode::RuntimeStartFailed => "DeepShell Runtime 启动失败",
            ErrorCode::RuntimeStopFailed => "DeepShell Runtime 未能安全停止",
            ErrorCode::LogsUnavailable => "日志目录当前不可用",
        }
    }
}

impl Display for AppError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for AppError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_message_does_not_expose_diagnostic_details() {
        let error = AppError::new(
            ErrorCode::RuntimeStartFailed,
            "无法读取 /Users/example/secret/config.json",
        );

        assert_eq!(error.user_message(), "DeepShell Runtime 启动失败");
        assert!(!error.user_message().contains("/Users/"));
    }
}
