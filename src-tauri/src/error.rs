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

    /// 诊断文本：包含"哪个步骤、什么原因"，只允许写入本机日志，不得直接展示给用户。
    ///
    /// 与 [`Self::user_message`] 的分工是硬边界：面向 UI 的文案固定且不含路径，
    /// 面向日志的文本才带细节。此前失败日志只记 `user_message()`，导致现场仅剩
    /// `runtime_stop_failed` 一个代号、根因全部丢失（本机 Windows 验收实测暴露）。
    pub fn diagnostic_message(&self) -> &str {
        &self.message
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

    #[test]
    fn diagnostic_message_keeps_the_root_cause_for_logs() {
        let error = AppError::new(
            ErrorCode::RuntimeStopFailed,
            "Runtime 启动失败（无法读取配置），且启动失败清理未完成（taskkill 超时）",
        );

        // 面向日志的一侧必须保留根因，且能看出是"启动失败 + 清理失败"双重故障。
        assert!(error.diagnostic_message().contains("无法读取配置"));
        assert!(error.diagnostic_message().contains("taskkill 超时"));
        assert!(error.to_string().starts_with("runtime_stop_failed: "));
        // 面向用户的文案依旧固定，不随诊断文本变化。
        assert_eq!(error.user_message(), "DeepShell Runtime 未能安全停止");
    }
}
