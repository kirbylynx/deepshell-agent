// NSIS 卸载兜底的受限维护命令（仅 Windows 使用）。
//
// 用法：
//   deepshell-agent.exe --maintenance cleanup-owned-runtime --install-root <INSTDIR>
//
// 约束（design §10 / REQ-1407）：
// 1. 在创建 WebView、注册 single-instance、启动 Sidecar **之前**处理并退出；
// 2. 只读取固定 app-data 下的 ownership record；
// 3. install root 必须是规范化绝对路径，且必须等于维护二进制自身所在目录；
//    出现符号链接 / junction / reparse point 或解析失败时，在枚举进程前失败；
// 4. 禁止按进程名批量终止；禁止终止主程序本身（应用运行中时必须失败并提示）；
// 5. 退出码是稳定契约，供 NSIS PREUNINSTALL hook 判定。
use crate::logging;
use crate::paths::strip_verbatim_prefix;
use crate::sidecar::{cleanup_for_uninstall, UninstallCleanup};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// 成功：当前安装目录下已无受管进程（可能清理了若干进程）。
pub const EXIT_OK: i32 = 0;
/// 参数用法错误。
pub const EXIT_USAGE: i32 = 10;
/// install root 无效（非绝对、不存在、受保护目录、含 reparse point、无法规范化）。
pub const EXIT_INVALID_INSTALL_ROOT: i32 = 11;
/// 维护二进制自身所在目录与传入的 install root 不一致。
pub const EXIT_ROOT_MISMATCH: i32 = 12;
/// 主程序仍在运行：卸载器必须提示用户先关闭应用。
pub const EXIT_APP_RUNNING: i32 = 13;
/// 无法证明当前安装目录未被受管进程占用（fail closed）。
pub const EXIT_UNVERIFIABLE: i32 = 14;
/// 清理失败（进程无法终止等）。
pub const EXIT_CLEANUP_FAILED: i32 = 15;

const CLEANUP_COMMAND: &str = "cleanup-owned-runtime";
const CLEANUP_DEADLINE: Duration = Duration::from_secs(20);

/// Windows 上应用数据目录的固定组成部分。
///
/// ⚠️ 必须与 `src-tauri/tauri.conf.json` 的 `identifier` 保持一致；维护模式在 Tauri
/// 初始化之前运行，无法通过 Tauri API 解析路径，因此这里显式拼接并做一致性测试保护。
const APP_DATA_DIRECTORY_NAME: &str = "com.deepshell.agent";

/// 参数以 `--maintenance` 开头时执行维护命令并返回退出码；普通启动返回 `None`。
pub fn run_if_requested() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) != Some("--maintenance") {
        return None;
    }
    Some(run(&args))
}

fn run(args: &[String]) -> i32 {
    if args.len() != 4
        || args[0] != "--maintenance"
        || args[1] != CLEANUP_COMMAND
        || args[2] != "--install-root"
    {
        eprintln!("usage: --maintenance {CLEANUP_COMMAND} --install-root <path>");
        return EXIT_USAGE;
    }
    let app_data = app_data_root();
    let install_root = match validate_install_root(Path::new(&args[3])) {
        Ok(path) => path,
        Err(code) => return finish(app_data.as_deref(), code, "invalid install root"),
    };

    // 维护二进制必须位于传入的安装目录中：否则拒绝（binary A 传 root B 的场景）。
    let executable = match std::env::current_exe() {
        Ok(path) => strip_verbatim_prefix(path),
        Err(error) => {
            return finish(
                app_data.as_deref(),
                EXIT_ROOT_MISMATCH,
                &format!("cannot resolve current executable: {error}"),
            )
        }
    };
    let executable_parent = executable
        .parent()
        .and_then(|parent| parent.canonicalize().ok());
    if executable_parent.as_deref() != Some(install_root.as_path()) {
        return finish(
            app_data.as_deref(),
            EXIT_ROOT_MISMATCH,
            "maintenance binary is not located in the requested install root",
        );
    }

    let Some(app_data) = app_data else {
        return finish(None, EXIT_UNVERIFIABLE, "APPDATA is unavailable");
    };
    let outcome = cleanup_for_uninstall(
        &install_root,
        &app_data,
        std::process::id(),
        Instant::now() + CLEANUP_DEADLINE,
    );
    match outcome {
        Ok(UninstallCleanup::Clean { terminated }) => finish(
            Some(&app_data),
            EXIT_OK,
            &format!("clean; terminated={terminated:?}"),
        ),
        Ok(UninstallCleanup::AppRunning { pid }) => finish(
            Some(&app_data),
            EXIT_APP_RUNNING,
            &format!("application still running; pid={pid}"),
        ),
        Ok(UninstallCleanup::Unverifiable { reason }) => {
            finish(Some(&app_data), EXIT_UNVERIFIABLE, &reason)
        }
        Err(error) => finish(
            Some(&app_data),
            EXIT_CLEANUP_FAILED,
            error.diagnostic_message(),
        ),
    }
}
fn finish(app_data: Option<&Path>, code: i32, detail: &str) -> i32 {
    if let Some(app_data) = app_data {
        let level = if code == EXIT_OK { "info" } else { "error" };
        let _ = logging::record_detailed(
            &app_data.join("logs"),
            level,
            "maintenance_exit",
            None,
            None,
            Some(&format!("code={code}; {detail}")),
        );
    }
    if code != EXIT_OK {
        eprintln!("maintenance {CLEANUP_COMMAND} failed: {code}: {detail}");
    }
    code
}

/// 校验 install root：必须是规范化绝对目录，且不得是受保护目录或包含 reparse point。
fn validate_install_root(raw: &Path) -> Result<PathBuf, i32> {
    if !raw.is_absolute() {
        return Err(EXIT_INVALID_INSTALL_ROOT);
    }
    if has_reparse_component(raw) {
        return Err(EXIT_INVALID_INSTALL_ROOT);
    }
    let canonical = raw.canonicalize().map_err(|_| EXIT_INVALID_INSTALL_ROOT)?;
    if canonical.parent().is_none() {
        // 磁盘根（如 `D:\`）没有父目录。
        return Err(EXIT_INVALID_INSTALL_ROOT);
    }
    if !canonical.is_dir() {
        return Err(EXIT_INVALID_INSTALL_ROOT);
    }
    for protected in [user_profile_root(), app_data_root()].into_iter().flatten() {
        if let Ok(protected) = protected.canonicalize() {
            if canonical == protected {
                return Err(EXIT_INVALID_INSTALL_ROOT);
            }
        }
    }
    Ok(canonical)
}

/// 逐级检查路径组件是否包含符号链接 / junction / 其它 reparse point。
///
/// 必须在 `canonicalize` **之前**检查：规范化会解析掉 reparse point，之后就看不到了。
fn has_reparse_component(path: &Path) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        let Ok(metadata) = std::fs::symlink_metadata(&current) else {
            // 尚不存在的组件：交给 canonicalize 报出无效根。
            return false;
        };
        if metadata.file_type().is_symlink()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
        {
            return true;
        }
    }
    false
}

fn user_profile_root() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").map(PathBuf::from)
}

/// 固定 app-data 目录：`%APPDATA%\<identifier>`。
fn app_data_root() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(|appdata| PathBuf::from(appdata).join(APP_DATA_DIRECTORY_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_and_missing_roots() {
        assert_eq!(
            validate_install_root(Path::new("relative\\dir")).unwrap_err(),
            EXIT_INVALID_INSTALL_ROOT
        );
        assert_eq!(
            validate_install_root(Path::new("Z:\\deepshell-does-not-exist")).unwrap_err(),
            EXIT_INVALID_INSTALL_ROOT
        );
    }

    #[test]
    fn rejects_drive_roots_and_protected_directories() {
        assert_eq!(
            validate_install_root(Path::new("C:\\")).unwrap_err(),
            EXIT_INVALID_INSTALL_ROOT
        );
        if let Some(profile) = user_profile_root() {
            assert_eq!(
                validate_install_root(&profile).unwrap_err(),
                EXIT_INVALID_INSTALL_ROOT
            );
        }
    }

    #[test]
    fn accepts_a_normal_directory() {
        let temporary = tempfile::tempdir().unwrap();
        let root = validate_install_root(temporary.path()).unwrap();
        assert_eq!(root, temporary.path().canonicalize().unwrap());
    }

    #[test]
    fn rejects_a_junction_component() {
        // junction 可由普通用户创建（无需开发者模式），且属于 reparse point。
        let temporary = tempfile::tempdir().unwrap();
        let target = temporary.path().join("real");
        std::fs::create_dir(&target).unwrap();
        let junction = temporary.path().join("link");
        let status = std::process::Command::new("cmd.exe")
            .args(["/d", "/s", "/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&target)
            .status()
            .unwrap();
        assert!(status.success(), "无法创建 junction");

        assert!(has_reparse_component(&junction.join("child")));
        assert_eq!(
            validate_install_root(&junction).unwrap_err(),
            EXIT_INVALID_INSTALL_ROOT
        );
    }

    #[test]
    fn app_data_directory_name_matches_tauri_identifier() {
        // 维护模式在 Tauri 初始化之前解析固定路径，必须与产品 identifier 保持同步。
        let config =
            std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tauri.conf.json"))
                .unwrap();
        assert!(
            config.contains(&format!("\"identifier\": \"{APP_DATA_DIRECTORY_NAME}\"")),
            "tauri.conf.json identifier 与维护模式的 app-data 目录名不一致"
        );
    }
}
