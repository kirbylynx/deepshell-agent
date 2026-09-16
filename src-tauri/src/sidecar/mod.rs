mod command;
mod handshake;
#[cfg(unix)]
mod process_tree;
#[cfg(windows)]
mod process_tree_windows;
mod supervisor;
#[cfg(unix)]
pub use self::process_tree::open_logs_directory;
#[cfg(windows)]
use self::process_tree_windows as process_tree;
#[cfg(windows)]
pub use self::process_tree_windows::open_logs_directory;
#[cfg(windows)]
pub use self::process_tree_windows::{cleanup_for_uninstall, UninstallCleanup};
pub use supervisor::{RuntimeSnapshot, Supervisor};
