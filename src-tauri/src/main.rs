// Windows 上必须以 **GUI 子系统**链接，否则 Windows 会为进程分配一个控制台窗口。
//
// 缺了本属性时，`main.rs` 默认按**控制台子系统**（`IMAGE_SUBSYSTEM_WINDOWS_CUI`）链接，
// 用户每次启动应用都会看到一个命令行窗口（标题为可执行文件路径）；
// 由于该控制台是由应用自身创建的，**关闭它就会连带关闭应用**
// （真机验收实测暴露：`pe-subsystem` 读出 Subsystem = 3）。
//
// `not(debug_assertions)`：release 构建为 GUI（无控制台），debug 构建保留控制台，
// 便于开发时直接看到 `println!`/panic 输出，也是 Tauri 官方模板的写法。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    deepshell_agent_lib::run();
}
