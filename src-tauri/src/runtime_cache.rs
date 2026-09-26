use crate::{
    error::{AppError, ErrorCode},
    paths::{sha256_file, AppPaths},
};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
    time::SystemTime,
};

const CACHE_MANIFEST: &str = "deepshell-cache-manifest.json";
const PACKAGER_VERSION: &str = "6.22.0";

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CacheManifest {
    schema_version: u32,
    platform: String,
    sea_sha256: String,
    packager_version: String,
    boot_successful: bool,
    files: Vec<CacheFile>,
}

#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CacheFile {
    path: String,
    bytes: u64,
    sha256: String,
}

/// 持有当前 SEA generation 的跨进程独占锁，锁生命周期覆盖整个 Sidecar 生命周期。
pub struct NativeCacheLease {
    _lock: File,
    generation_root: PathBuf,
    pkg_native: PathBuf,
    platform: String,
    sea_sha256: String,
}

impl Drop for NativeCacheLease {
    fn drop(&mut self) {
        // macOS 并行测试证明仅依赖 File 的析构释放时序可能让紧接着的非阻塞重取
        // 短暂观察到 WouldBlock；显式 unlock 也让 Runtime 停止后的重启边界更确定。
        let _ = fs2::FileExt::unlock(&self._lock);
    }
}

impl NativeCacheLease {
    pub fn pkg_native(&self) -> &Path {
        &self.pkg_native
    }

    pub fn record_success(&mut self) -> Result<usize, AppError> {
        let manifest = CacheManifest {
            schema_version: 1,
            platform: self.platform.clone(),
            sea_sha256: self.sea_sha256.clone(),
            packager_version: PACKAGER_VERSION.into(),
            boot_successful: true,
            files: scan_cache_files(&self.pkg_native)?,
        };
        write_manifest_transactionally(&self.generation_root.join(CACHE_MANIFEST), &manifest)?;
        Ok(cleanup_old_generations(
            &self.generation_root,
            &self.platform,
            &self.sea_sha256,
        ))
    }
}

pub fn acquire(paths: &AppPaths) -> Result<Option<NativeCacheLease>, AppError> {
    let Some(sea_sha256) = paths.runtime_launch.sea_sha256() else {
        return Ok(None);
    };
    let platform = runtime_platform().to_owned();
    let platform_root = paths.native_cache_root.join(&platform);
    let cache_parent = paths.native_cache_root.parent().ok_or_else(|| {
        AppError::new(
            ErrorCode::RuntimeUnavailable,
            "SEA Native Cache 缺少受控父目录",
        )
    })?;
    // `create_dir_all(native)` 会跟随已经存在的中间 symlink/reparse point，因此必须先
    // 单独创建并验证 app-data/runtime-cache，再创建下一级目录。
    private_directory(cache_parent)?;
    private_directory(&paths.native_cache_root)?;
    private_directory(&platform_root)?;
    reject_symlink(&platform_root)?;

    let generation_name = generation_directory_name(sea_sha256);
    let lock_path = platform_root.join(format!("{generation_name}.lock"));
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(cache_error)?;
    private_file(&lock_path)?;
    match lock.try_lock_exclusive() {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "SEA Native Cache 正被另一个 Runtime 使用",
            ));
        }
        Err(error) => return Err(cache_error(error)),
    }

    let generation_root = platform_root.join(generation_name);
    prepare_generation(&generation_root, &platform, sea_sha256)?;
    let pkg_native = generation_root.join("pkg-native");
    private_directory(&pkg_native)?;
    Ok(Some(NativeCacheLease {
        _lock: lock,
        generation_root,
        pkg_native,
        platform,
        sea_sha256: sea_sha256.to_owned(),
    }))
}

fn prepare_generation(root: &Path, platform: &str, sea_sha256: &str) -> Result<(), AppError> {
    match fs::symlink_metadata(root) {
        Ok(metadata) if is_link_or_reparse(&metadata) || !metadata.is_dir() => {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "SEA Native Cache generation 必须是真实目录",
            ));
        }
        Ok(_) => {
            if !generation_is_valid(root, platform, sea_sha256)? {
                quarantine_generation(root)?;
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(cache_error(error)),
    }
    private_directory(root)
}

fn generation_is_valid(root: &Path, platform: &str, sea_sha256: &str) -> Result<bool, AppError> {
    let entries = fs::read_dir(root)
        .map_err(cache_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(cache_error)?;
    if entries.is_empty() {
        return Ok(true);
    }
    let manifest_path = root.join(CACHE_MANIFEST);
    let metadata = match fs::symlink_metadata(&manifest_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(cache_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 1_048_576 {
        return Ok(false);
    }
    let manifest = match fs::read(&manifest_path)
        .map_err(cache_error)
        .and_then(|bytes| serde_json::from_slice::<CacheManifest>(&bytes).map_err(json_error))
    {
        Ok(manifest) => manifest,
        Err(_) => return Ok(false),
    };
    if manifest.schema_version != 1
        || manifest.platform != platform
        || manifest.sea_sha256 != sea_sha256
        || manifest.packager_version != PACKAGER_VERSION
        || !manifest.boot_successful
    {
        return Ok(false);
    }
    Ok(
        scan_cache_files(&root.join("pkg-native"))? == manifest.files
            && entries.iter().all(|entry| {
                matches!(
                    entry.file_name().to_str(),
                    Some(CACHE_MANIFEST | "pkg-native")
                )
            }),
    )
}

fn quarantine_generation(root: &Path) -> Result<(), AppError> {
    let parent = root.parent().ok_or_else(|| {
        AppError::new(
            ErrorCode::RuntimeUnavailable,
            "SEA Native Cache generation 缺少父目录",
        )
    })?;
    reject_symlink(parent)?;
    let quarantine = parent.join(format!(
        ".invalid-{}-{}",
        root.file_name().unwrap_or_default().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    fs::rename(root, &quarantine).map_err(cache_error)?;
    fs::remove_dir_all(&quarantine).map_err(cache_error)
}

/// 保留当前 generation 和一个最近成功的旧 generation。只删除名称、manifest、平台、
/// SHA256 和 packager 均能证明归属，且能非阻塞取得 sibling lock 的更旧目录。
/// 返回清理失败数；调用方只记录告警，不得因此阻断 Runtime 启动。
fn cleanup_old_generations(current: &Path, platform: &str, current_sha256: &str) -> usize {
    let Some(platform_root) = current.parent() else {
        return 1;
    };
    let entries = match fs::read_dir(platform_root) {
        Ok(entries) => entries,
        Err(_) => return 1,
    };
    let mut failures = 0;
    let mut candidates = Vec::new();
    let current_name = generation_directory_name(current_sha256).to_owned();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                failures += 1;
                continue;
            }
        };
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        // generation 目录名是完整 SHA256 的前 16 位；跳过当前目录与非 generation 名。
        if name == current_name || !is_generation_directory_name(&name) {
            continue;
        }
        match fs::symlink_metadata(entry.path()) {
            Ok(metadata) if metadata.is_dir() && !is_link_or_reparse(&metadata) => {}
            _ => continue,
        }
        match generation_sha256_for_directory(&entry.path(), platform) {
            Ok(Some(sha256)) => match generation_is_valid(&entry.path(), platform, &sha256) {
                Ok(true) => {
                    let modified = fs::metadata(entry.path().join(CACHE_MANIFEST))
                        .and_then(|value| value.modified())
                        .unwrap_or(SystemTime::UNIX_EPOCH);
                    candidates.push((modified, name, entry.path()));
                }
                Ok(false) => {}
                Err(_) => failures += 1,
            },
            Ok(None) => {}
            Err(_) => failures += 1,
        }
    }
    candidates.sort_by(|left, right| right.0.cmp(&left.0).then_with(|| right.1.cmp(&left.1)));
    for (_, name, generation) in candidates.into_iter().skip(1) {
        let lock_path = platform_root.join(format!("{name}.lock"));
        let lock = match OpenOptions::new().read(true).write(true).open(&lock_path) {
            Ok(lock) => lock,
            Err(_) => {
                failures += 1;
                continue;
            }
        };
        if reject_symlink(&lock_path).is_err() {
            failures += 1;
            continue;
        }
        match lock.try_lock_exclusive() {
            Ok(()) => {
                // 候选扫描与取得 sibling lock 之间可能有另一进程或同用户修改目录；
                // 删除前在锁内重新验证类型、manifest 与内容，避免 TOCTOU。
                let still_owned = fs::symlink_metadata(&generation)
                    .map(|metadata| metadata.is_dir() && !is_link_or_reparse(&metadata))
                    .unwrap_or(false)
                    && matches!(
                        generation_sha256_for_directory(&generation, platform),
                        Ok(Some(sha256))
                            if matches!(
                                generation_is_valid(&generation, platform, &sha256),
                                Ok(true)
                            )
                    );
                if !still_owned || fs::remove_dir_all(generation).is_err() {
                    failures += 1;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(_) => failures += 1,
        }
    }
    failures
}

fn scan_cache_files(root: &Path) -> Result<Vec<CacheFile>, AppError> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    reject_symlink(root)?;
    let mut files = Vec::new();
    scan_directory(root, root, &mut files)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(files)
}

fn scan_directory(root: &Path, current: &Path, files: &mut Vec<CacheFile>) -> Result<(), AppError> {
    let mut entries = fs::read_dir(current)
        .map_err(cache_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(cache_error)?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let metadata = fs::symlink_metadata(entry.path()).map_err(cache_error)?;
        let file_type = metadata.file_type();
        if is_link_or_reparse(&metadata) {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "SEA Native Cache 不允许符号链接或 reparse point",
            ));
        }
        if file_type.is_dir() {
            scan_directory(root, &entry.path(), files)?;
        } else if file_type.is_file() {
            let entry_path = entry.path();
            let relative = entry_path.strip_prefix(root).map_err(|_| {
                AppError::new(ErrorCode::RuntimeUnavailable, "SEA Native Cache 路径越界")
            })?;
            files.push(CacheFile {
                path: relative.to_string_lossy().replace('\\', "/"),
                bytes: metadata.len(),
                sha256: sha256_file(&entry_path)?,
            });
        } else {
            return Err(AppError::new(
                ErrorCode::RuntimeUnavailable,
                "SEA Native Cache 包含不支持的文件类型",
            ));
        }
    }
    Ok(())
}

fn write_manifest_transactionally(path: &Path, manifest: &CacheManifest) -> Result<(), AppError> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(manifest).map_err(json_error)?,
        )
        .map_err(cache_error)?;
        private_file(&temporary)?;
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), AppError> {
    fs::rename(source, destination).map_err(cache_error)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), AppError> {
    use std::{iter::once, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let source = source
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(cache_error(std::io::Error::last_os_error()))
    } else {
        Ok(())
    }
}

fn private_directory(path: &Path) -> Result<(), AppError> {
    fs::create_dir_all(path).map_err(cache_error)?;
    reject_symlink(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(cache_error)?;
    }
    Ok(())
}

fn private_file(path: &Path) -> Result<(), AppError> {
    reject_symlink(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(cache_error)?;
    }
    Ok(())
}

fn reject_symlink(path: &Path) -> Result<(), AppError> {
    let metadata = fs::symlink_metadata(path).map_err(cache_error)?;
    if is_link_or_reparse(&metadata) {
        return Err(AppError::new(
            ErrorCode::RuntimeUnavailable,
            "SEA Native Cache 路径不能是符号链接或 reparse point",
        ));
    }
    Ok(())
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    false
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// generation 目录名 = 完整 SEA SHA256 的前 16 位十六进制字符。
/// Windows 的 MAX_PATH 限制下，完整 64 字符会使 pkg 物化出的 native 路径超过 260 字符
/// （sharp/koffi 的 dlopen 会以“文件名或扩展名太长”失败）；manifest 内仍保存完整
/// SHA256，目录名只作为 generation 标识。
fn generation_directory_name(sea_sha256: &str) -> &str {
    sea_sha256.get(..16).unwrap_or(sea_sha256)
}

fn is_generation_directory_name(value: &str) -> bool {
    value.len() == 16
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// 读取 generation 目录内 manifest 的完整 SEA SHA256；目录名必须等于其前 16 位。
fn generation_sha256_for_directory(
    root: &Path,
    platform: &str,
) -> Result<Option<String>, AppError> {
    let Some(name) = root.file_name().and_then(|value| value.to_str()) else {
        return Ok(None);
    };
    if !is_generation_directory_name(name) {
        return Ok(None);
    }
    let manifest_path = root.join(CACHE_MANIFEST);
    let metadata = match fs::symlink_metadata(&manifest_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(cache_error(error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 1_048_576 {
        return Ok(None);
    }
    let manifest = match fs::read(&manifest_path)
        .map_err(cache_error)
        .and_then(|bytes| serde_json::from_slice::<CacheManifest>(&bytes).map_err(json_error))
    {
        Ok(manifest) => manifest,
        Err(_) => return Ok(None),
    };
    if manifest.platform != platform
        || !is_sha256(&manifest.sea_sha256)
        || generation_directory_name(&manifest.sea_sha256) != name
    {
        return Ok(None);
    }
    Ok(Some(manifest.sea_sha256))
}

fn runtime_platform() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "darwin-arm64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "win32-x64"
    }
}

fn cache_error(error: std::io::Error) -> AppError {
    AppError::new(ErrorCode::RuntimeUnavailable, error.to_string())
}

fn json_error(error: serde_json::Error) -> AppError {
    AppError::new(ErrorCode::RuntimeUnavailable, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::RuntimeLaunch;

    fn sea_paths(root: &Path) -> AppPaths {
        let resources = root.join("resources");
        let data = root.join("data");
        let mut paths = AppPaths::new(data, resources.clone()).unwrap();
        let platform = runtime_platform();
        paths.runtime_launch = RuntimeLaunch::Sea {
            executable: resources.join(format!("runtime/sea/{platform}/deepshell-runtime")),
            manifest: resources.join(format!("runtime/sea/{platform}/sea-runtime-manifest.json")),
            sha256: "a".repeat(64),
        };
        paths
    }

    #[test]
    fn stable_manifest_validates_and_corruption_rebuilds_generation() {
        let temporary = tempfile::tempdir().unwrap();
        let paths = sea_paths(temporary.path());
        let mut first = acquire(&paths).unwrap().unwrap();
        fs::write(first.pkg_native().join("addon.node"), b"native").unwrap();
        assert_eq!(first.record_success().unwrap(), 0);
        drop(first);

        let second = acquire(&paths).unwrap().unwrap();
        assert_eq!(
            fs::read(second.pkg_native().join("addon.node")).unwrap(),
            b"native"
        );
        drop(second);

        fs::write(
            paths
                .native_cache_root
                .join(runtime_platform())
                .join("a".repeat(16))
                .join("pkg-native/addon.node"),
            b"corrupt",
        )
        .unwrap();
        let rebuilt = acquire(&paths).unwrap().unwrap();
        assert!(!rebuilt.pkg_native().join("addon.node").exists());
    }

    #[test]
    fn cleanup_retains_current_and_previous_successful_generation() {
        use std::{thread, time::Duration};

        let temporary = tempfile::tempdir().unwrap();
        let mut paths = sea_paths(temporary.path());
        let shas = ["a".repeat(64), "b".repeat(64), "c".repeat(64)];
        for sha256 in &shas {
            paths.runtime_launch = RuntimeLaunch::Sea {
                executable: paths.resources_root.join(format!(
                    "runtime/sea/{}/deepshell-runtime",
                    runtime_platform()
                )),
                manifest: paths.resources_root.join(format!(
                    "runtime/sea/{}/sea-runtime-manifest.json",
                    runtime_platform()
                )),
                sha256: sha256.clone(),
            };
            let mut lease = acquire(&paths).unwrap().unwrap();
            fs::write(lease.pkg_native().join("addon.node"), sha256).unwrap();
            assert_eq!(lease.record_success().unwrap(), 0);
            drop(lease);
            thread::sleep(Duration::from_millis(10));
        }
        let root = paths.native_cache_root.join(runtime_platform());
        // generation 目录名是完整 SEA SHA256 的前 16 位。
        let directory_name = |sha256: &str| sha256[..16].to_owned();
        assert!(!root.join(directory_name(&shas[0])).exists());
        assert!(root.join(directory_name(&shas[1])).is_dir());
        assert!(root.join(directory_name(&shas[2])).is_dir());
    }

    #[test]
    fn generation_directory_name_keeps_windows_paths_within_max_path() {
        // W2-F001 回归保护：generation 目录必须使用 SHA256 前缀，否则 pkg 物化的
        // native 路径在 Windows 上会超过 MAX_PATH（260），sharp/koffi 的 dlopen 失败。
        let long_sha = "27698d7c953e0b6c6d3b0c906ecc62822ab7e6072d97d6d38a01f4342e1882d9";
        let directory = generation_directory_name(long_sha);
        assert_eq!(directory.len(), 16);
        assert!(is_generation_directory_name(directory));
        // 最坏 app-data 前缀（长用户名）+ 实际 pkg 物化后缀。
        let prefix = r"C:\Users\verylongusername\AppData\Roaming\com.deepshell.agent\runtime-cache\native\win32-x64";
        let suffix = r"\pkg-native\pkg\0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\@img\sharp-win32-x64\lib\sharp-win32-x64-0.35.4.node";
        let full = format!("{prefix}\\{directory}{suffix}");
        assert!(
            full.len() < 260,
            "generation 路径长度 {} 必须小于 260",
            full.len()
        );
    }

    #[test]
    fn generation_lock_is_exclusive_and_never_blocks_startup() {
        let temporary = tempfile::tempdir().unwrap();
        let paths = sea_paths(temporary.path());
        let first = acquire(&paths).unwrap().unwrap();
        let error = acquire(&paths).err().expect("竞争锁必须立即失败");
        assert_eq!(error.code(), ErrorCode::RuntimeUnavailable);
        drop(first);
        assert!(acquire(&paths).unwrap().is_some());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_runtime_cache_parent() {
        use std::os::unix::fs::symlink;

        let temporary = tempfile::tempdir().unwrap();
        let outside = temporary.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let paths = sea_paths(temporary.path());
        fs::create_dir_all(&paths.app_data).unwrap();
        symlink(&outside, paths.app_data.join("runtime-cache")).unwrap();

        let error = acquire(&paths).err().expect("symlinked parent 必须被拒绝");
        assert_eq!(error.code(), ErrorCode::RuntimeUnavailable);
        assert!(!outside.join("native").exists());
    }
}
