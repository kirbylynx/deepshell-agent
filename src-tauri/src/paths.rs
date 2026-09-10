use crate::error::{AppError, ErrorCode};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone)]
pub struct AppPaths {
    pub app_data: PathBuf,
    pub dsh_home: PathBuf,
    pub workspace: PathBuf,
    pub process_home: PathBuf,
    pub logs: PathBuf,
    pub ready_file: PathBuf,
    pub ownership_file: PathBuf,
    pub node: PathBuf,
    pub dsh_entry: PathBuf,
    pub profile_template: PathBuf,
}

impl AppPaths {
    pub fn new(app_data: PathBuf, resources: PathBuf) -> Result<Self, AppError> {
        if !app_data.is_absolute() || !resources.is_absolute() {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "Runtime 路径必须是绝对路径",
            ));
        }
        let dsh_home = app_data.join("dsh-home");
        let runtime_state = app_data.join("runtime-state");
        let runtime = resources.join("runtime");
        Ok(Self {
            workspace: app_data.join("bootstrap-workspace"),
            process_home: app_data.join("process-home"),
            logs: app_data.join("logs"),
            ready_file: runtime_state.join("client-ready.json"),
            ownership_file: runtime_state.join("ownership.json"),
            node: runtime.join(runtime_node_path()),
            dsh_entry: runtime.join("dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
            profile_template: runtime.join("profile-template"),
            app_data,
            dsh_home,
        })
    }

    pub fn prepare(&self) -> Result<(), AppError> {
        for directory in [
            &self.app_data,
            &self.workspace,
            &self.process_home,
            &self.logs,
            self.ready_file.parent().expect("ready file 必须有父目录"),
        ] {
            private_directory(directory)?;
        }
        if !self.node.is_file() || !self.dsh_entry.is_file() || !self.profile_template.is_dir() {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "Bundled Node、DSH 或 Profile 模板缺失",
            ));
        }
        self.materialize_profile()?;
        let _ = fs::remove_file(&self.ready_file);
        Ok(())
    }

    fn materialize_profile(&self) -> Result<(), AppError> {
        let template_manifest = self.profile_template.join("template-manifest.json");
        let template_profile = self.profile_template.join("profiles/web");
        let template_agent_presets = self.profile_template.join(".agent-presets");
        if !template_manifest.is_file()
            || !template_profile.join("package.json").is_file()
            || !template_agent_presets
                .join("deepshell-coding/agent.cordis.yml")
                .is_file()
            || !template_agent_presets
                .join("deepshell-coding/preset.yml")
                .is_file()
            || !template_agent_presets
                .join("deepshell-work/agent.cordis.yml")
                .is_file()
            || !template_agent_presets
                .join("deepshell-work/preset.yml")
                .is_file()
            || !template_agent_presets
                .join("deepshell-general/agent.cordis.yml")
                .is_file()
            || !template_agent_presets
                .join("deepshell-general/preset.yml")
                .is_file()
            || !template_agent_presets
                .join("deepshell/agent.cordis.yml")
                .is_file()
            || !template_agent_presets
                .join("deepshell/preset.yml")
                .is_file()
        {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "Profile 模板不完整",
            ));
        }
        let dsh_home_metadata = match fs::symlink_metadata(&self.dsh_home) {
            Ok(metadata) => Some(metadata),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(runtime_error(error)),
        };
        if dsh_home_metadata.is_none() {
            let staging = self
                .app_data
                .join(format!(".dsh-home-next-{}", uuid::Uuid::new_v4()));
            copy_tree(&self.profile_template, &staging)?;
            fs::rename(&staging, &self.dsh_home).map_err(|error| {
                let _ = fs::remove_dir_all(&staging);
                AppError::new(
                    ErrorCode::RuntimeUnavailable,
                    format!("无法原子初始化 DSH_HOME：{error}"),
                )
            })?;
            return Ok(());
        }
        let dsh_home_metadata = dsh_home_metadata.expect("已检查 DSH_HOME 存在");
        if dsh_home_metadata.file_type().is_symlink() || !dsh_home_metadata.is_dir() {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "DSH_HOME 必须是真实目录，不能是符号链接",
            ));
        }
        private_directory(&self.dsh_home)?;
        let current_manifest = self.dsh_home.join("template-manifest.json");
        let current_profile = self.dsh_home.join("profiles/web");
        let current_agent_presets = self.dsh_home.join(".agent-presets");
        let current_profile_exists = real_directory_exists(&current_profile, "当前 Profile")?;
        let current_agent_presets_exists =
            real_directory_exists(&current_agent_presets, "DeepShell Agent Presets")?;
        if current_profile_exists
            && current_agent_presets_exists
            && trees_equal(&template_profile, &current_profile)?
            && trees_equal(&template_agent_presets, &current_agent_presets)?
            && files_equal(&template_manifest, &current_manifest)?
        {
            return Ok(());
        }

        let profiles = self.dsh_home.join("profiles");
        private_directory(&profiles)?;
        replace_owned_directory(&template_profile, &current_profile, &profiles, "web")?;
        replace_owned_directory(
            &template_agent_presets,
            &current_agent_presets,
            &self.dsh_home,
            "agent-presets",
        )?;
        let suffix = uuid::Uuid::new_v4().to_string();
        let manifest_staging = self
            .dsh_home
            .join(format!(".template-manifest-{suffix}.json"));
        fs::copy(&template_manifest, &manifest_staging).map_err(runtime_error)?;
        set_private_file_permissions(&manifest_staging).map_err(runtime_error)?;
        fs::rename(&manifest_staging, &current_manifest).map_err(runtime_error)?;
        Ok(())
    }
}

fn runtime_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::RuntimeUnavailable, error.to_string())
}

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn runtime_node_path() -> &'static str {
    "node/darwin-arm64/bin/node"
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn runtime_node_path() -> &'static str {
    "node/win32-x64/node.exe"
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

#[cfg(unix)]
fn source_is_executable(path: &Path) -> Result<bool, AppError> {
    use std::os::unix::fs::PermissionsExt;
    Ok(fs::metadata(path)
        .map_err(runtime_error)?
        .permissions()
        .mode()
        & 0o100
        != 0)
}

#[cfg(not(unix))]
fn source_is_executable(_path: &Path) -> Result<bool, AppError> {
    Ok(false)
}

fn files_equal(left: &Path, right: &Path) -> Result<bool, AppError> {
    match fs::symlink_metadata(right) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "Profile manifest 必须是真实文件，不能是符号链接",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(runtime_error(error)),
    }
    Ok(fs::read(left).map_err(runtime_error)? == fs::read(right).map_err(runtime_error)?)
}

fn trees_equal(left: &Path, right: &Path) -> Result<bool, AppError> {
    let right_metadata = match fs::symlink_metadata(right) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "应用拥有的 Profile 树必须是真实目录，不能是符号链接",
            ));
        }
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(runtime_error(error)),
    };
    if !right_metadata.is_dir() {
        return Ok(false);
    }
    let mut left_entries = fs::read_dir(left)
        .map_err(runtime_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(runtime_error)?;
    let mut right_entries = fs::read_dir(right)
        .map_err(runtime_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(runtime_error)?;
    left_entries.sort_by_key(|entry| entry.file_name());
    right_entries.sort_by_key(|entry| entry.file_name());
    if left_entries.len() != right_entries.len()
        || left_entries
            .iter()
            .zip(&right_entries)
            .any(|(left, right)| left.file_name() != right.file_name())
    {
        return Ok(false);
    }
    for (left_entry, right_entry) in left_entries.into_iter().zip(right_entries) {
        let left_type = left_entry.file_type().map_err(runtime_error)?;
        let right_type = right_entry.file_type().map_err(runtime_error)?;
        if right_type.is_symlink() || left_type.is_dir() != right_type.is_dir() {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "应用拥有的 Profile 树包含无效文件类型",
            ));
        }
        if left_type.is_dir() {
            if !trees_equal(&left_entry.path(), &right_entry.path())? {
                return Ok(false);
            }
        } else if !left_type.is_file()
            || !right_type.is_file()
            || fs::read(left_entry.path()).map_err(runtime_error)?
                != fs::read(right_entry.path()).map_err(runtime_error)?
        {
            return Ok(false);
        }
    }
    Ok(true)
}

fn private_directory(path: &Path) -> Result<(), AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "Runtime 私有目录必须是真实目录，不能是符号链接",
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(path).map_err(runtime_error)?;
            let metadata = fs::symlink_metadata(path).map_err(runtime_error)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(AppError::new(
                    ErrorCode::RuntimeUnavailable,
                    "Runtime 私有目录创建后类型无效",
                ));
            }
        }
        Err(error) => return Err(runtime_error(error)),
    }
    set_private_directory_permissions(path).map_err(runtime_error)
}

fn real_directory_exists(path: &Path, label: &str) -> Result<bool, AppError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                format!("{label} 必须是真实目录，不能是符号链接"),
            ))
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(runtime_error(error)),
    }
}

fn replace_owned_directory(
    source: &Path,
    destination: &Path,
    parent: &Path,
    name: &str,
) -> Result<(), AppError> {
    let suffix = uuid::Uuid::new_v4().to_string();
    let staging = parent.join(format!(".{name}-next-{suffix}"));
    let backup = parent.join(format!(".{name}-previous-{suffix}"));
    copy_tree(source, &staging)?;
    let existed = real_directory_exists(destination, name)?;
    if existed {
        fs::rename(destination, &backup).map_err(runtime_error)?;
    }
    if let Err(error) = fs::rename(&staging, destination) {
        if existed {
            let _ = fs::rename(&backup, destination);
        }
        let _ = fs::remove_dir_all(&staging);
        return Err(runtime_error(error));
    }
    if existed {
        let _ = fs::remove_dir_all(backup);
    }
    Ok(())
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), AppError> {
    private_directory(destination)?;
    for entry in fs::read_dir(source).map_err(runtime_error)? {
        let entry = entry.map_err(runtime_error)?;
        let file_type = entry.file_type().map_err(runtime_error)?;
        if file_type.is_symlink() || (!file_type.is_dir() && !file_type.is_file()) {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "Profile 模板包含不允许的文件类型",
            ));
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target).map_err(runtime_error)?;
            if source_is_executable(&entry.path())? {
                set_private_directory_permissions(&target).map_err(runtime_error)?;
            } else {
                set_private_file_permissions(&target).map_err(runtime_error)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_roots() {
        assert!(AppPaths::new("relative".into(), "relative".into()).is_err());
    }

    #[test]
    fn profile_upgrade_preserves_unowned_data() {
        let temporary = tempfile::tempdir().unwrap();
        let resources = temporary.path().join("resources");
        let runtime = resources.join("runtime");
        let template = runtime.join("profile-template");
        fs::create_dir_all(template.join("profiles/web")).unwrap();
        fs::create_dir_all(
            template.join("profiles/web/node_modules/@deepshell-agent/dsh-desktop/lib"),
        )
        .unwrap();
        fs::create_dir_all(template.join(".agent-presets/deepshell-coding")).unwrap();
        fs::create_dir_all(template.join(".agent-presets/deepshell-work")).unwrap();
        fs::create_dir_all(template.join(".agent-presets/deepshell-general")).unwrap();
        fs::create_dir_all(template.join(".agent-presets/deepshell")).unwrap();
        fs::create_dir_all(runtime.join(runtime_node_path()).parent().unwrap()).unwrap();
        fs::create_dir_all(runtime.join("dsh/node_modules/@deepseek-ai/dsh/lib")).unwrap();
        fs::write(runtime.join(runtime_node_path()), "node").unwrap();
        fs::write(
            runtime.join("dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
            "dsh",
        )
        .unwrap();
        fs::write(template.join("template-manifest.json"), "v1").unwrap();
        fs::write(template.join("profiles/web/package.json"), "v1").unwrap();
        fs::write(
            template.join("profiles/web/node_modules/@deepshell-agent/dsh-desktop/lib/client.js"),
            "client-v1",
        )
        .unwrap();
        fs::write(
            template.join(".agent-presets/deepshell-coding/agent.cordis.yml"),
            "agent-v1",
        )
        .unwrap();
        fs::write(
            template.join(".agent-presets/deepshell-coding/preset.yml"),
            "preset-v1",
        )
        .unwrap();
        fs::write(
            template.join(".agent-presets/deepshell-work/agent.cordis.yml"),
            "agent-v1",
        )
        .unwrap();
        fs::write(
            template.join(".agent-presets/deepshell-work/preset.yml"),
            "preset-v1",
        )
        .unwrap();
        fs::write(
            template.join(".agent-presets/deepshell-general/agent.cordis.yml"),
            "agent-v1",
        )
        .unwrap();
        fs::write(
            template.join(".agent-presets/deepshell-general/preset.yml"),
            "preset-v1",
        )
        .unwrap();
        fs::write(
            template.join(".agent-presets/deepshell/agent.cordis.yml"),
            "agent-v1",
        )
        .unwrap();
        fs::write(
            template.join(".agent-presets/deepshell/preset.yml"),
            "preset-v1",
        )
        .unwrap();
        let paths = AppPaths::new(temporary.path().join("data"), resources).unwrap();
        paths.prepare().unwrap();
        fs::write(paths.dsh_home.join("session-data"), "keep").unwrap();
        fs::write(template.join("template-manifest.json"), "v2").unwrap();
        fs::write(template.join("profiles/web/package.json"), "v2").unwrap();
        fs::write(
            template.join(".agent-presets/deepshell-coding/agent.cordis.yml"),
            "agent-v2",
        )
        .unwrap();
        paths.prepare().unwrap();
        assert_eq!(
            fs::read_to_string(paths.dsh_home.join("session-data")).unwrap(),
            "keep"
        );
        assert_eq!(
            fs::read_to_string(paths.dsh_home.join("profiles/web/package.json")).unwrap(),
            "v2"
        );
        assert_eq!(
            fs::read_to_string(
                paths
                    .dsh_home
                    .join(".agent-presets/deepshell-coding/agent.cordis.yml")
            )
            .unwrap(),
            "agent-v2"
        );

        let installed_client = paths
            .dsh_home
            .join("profiles/web/node_modules/@deepshell-agent/dsh-desktop/lib/client.js");
        fs::write(&installed_client, "corrupted").unwrap();
        paths.prepare().unwrap();
        assert_eq!(fs::read_to_string(installed_client).unwrap(), "client-v1");
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_app_data_root() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let actual = temporary.path().join("actual-data");
        let linked = temporary.path().join("linked-data");
        fs::create_dir(&actual).unwrap();
        symlink(&actual, &linked).unwrap();
        assert!(private_directory(&linked).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_profile_manifest() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let expected = temporary.path().join("expected.json");
        let actual = temporary.path().join("actual.json");
        let linked = temporary.path().join("linked.json");
        fs::write(&expected, "same").unwrap();
        fs::write(&actual, "same").unwrap();
        symlink(&actual, &linked).unwrap();
        assert!(files_equal(&expected, &linked).is_err());
    }
}
