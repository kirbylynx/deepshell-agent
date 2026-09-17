// 平台原生菜单：macOS 保留应用菜单，Windows 使用最小 File/Help 菜单。
//
// 设计依据：docs/plans/v0.1.4-packaging/design.md §8、要求 D-1408 / REQ-1412。
//
// 硬约束：
// 1. 平台差异只用 `#[cfg(target_os = ...)]` 条件编译；不做运行时嗅探，不修改官方 DSH Web UI；
// 2. macOS 应用菜单逐项保留既有基线（产品名 + About/Services/Hide/Hide Others/Quit）；
// 3. Windows 顶层菜单不得重复产品名（窗口标题已经显示一次），也不得出现 macOS 专属项；
// 4. Windows `Exit` 与 macOS `Quit` 都必须经过统一安全退出入口 `request_exit`：
//    先幂等 `stop_runtime()`，成功才退出，失败时记录脱敏错误并阻止退出。
use tauri::menu::{
    AboutMetadata, AboutMetadataBuilder, Menu, MenuItem, PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Manager, Runtime};

use crate::app_state::AppState;

pub const PRODUCT_NAME: &str = "DeepShell Agent";

/// 自定义退出菜单项的稳定 ID；事件路由只认这个常量。
pub const EXIT_MENU_ID: &str = "file.exit";

/// 菜单条目种类：规格只描述结构，构建时按平台映射到 Tauri 菜单项。
///
/// macOS 专属变体（Services/Hide/HideOthers/Quit）在非 macOS 构建中不会出现在规格里，
/// 因此只在该平台之外豁免 dead_code 检查。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ItemKind {
    /// 关于：macOS 放在应用菜单（文案交给系统），Windows 放在 Help 菜单（固定文案）。
    About,
    Services,
    Hide,
    HideOthers,
    Quit,
    /// 自定义退出项：必须路由到 `request_exit`。
    Exit,
    Separator,
}

/// 顶层子菜单规格。
#[derive(Clone, Copy, Debug)]
pub struct MenuSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub items: &'static [ItemKind],
}

/// macOS：系统菜单栏应用菜单（与既有基线逐项一致）。
#[cfg(target_os = "macos")]
pub const APPLICATION_MENU: &[MenuSpec] = &[MenuSpec {
    id: "app",
    label: PRODUCT_NAME,
    items: &[
        ItemKind::About,
        ItemKind::Separator,
        ItemKind::Services,
        ItemKind::Separator,
        ItemKind::Hide,
        ItemKind::HideOthers,
        ItemKind::Separator,
        ItemKind::Quit,
    ],
}];

/// Windows（及其它非 macOS 平台）：最小可用菜单，不使用产品名做菜单标题。
#[cfg(not(target_os = "macos"))]
pub const APPLICATION_MENU: &[MenuSpec] = &[
    MenuSpec {
        id: "file",
        label: "File",
        items: &[ItemKind::Exit],
    },
    MenuSpec {
        id: "help",
        label: "Help",
        items: &[ItemKind::About],
    },
];

/// 从 `runtime-lock.json` 构造 credits（`include_str!` 让 rustc 追踪该文件变化），
/// 避免 About 信息与锁定运行时漂移（此前的版本号是硬编码字符串）。
fn runtime_credits() -> String {
    let lock: serde_json::Value =
        serde_json::from_str(include_str!("../../runtime/manifest/runtime-lock.json"))
            .expect("runtime-lock.json 必须可解析");
    let version = |key: &str| {
        lock.get(key)
            .and_then(|value| value.get("version"))
            .and_then(|value| value.as_str())
            .unwrap_or("unknown")
    };
    format!(
        "A desktop agent powered by DeepSeek Harness.\nNode.js {}\nDeepSeek Harness {}",
        version("node"),
        version("dsh"),
    )
}

/// 共享 About 元数据：两个平台使用同一份产品名、版本与 credits。
pub fn about_metadata() -> AboutMetadata<'static> {
    AboutMetadataBuilder::new()
        .name(Some(PRODUCT_NAME))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .credits(Some(runtime_credits()))
        .build()
}

fn about_label() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        // macOS 应用菜单的 About 文案由系统本地化。
        None
    } else {
        Some("About DeepShell Agent")
    }
}

/// 按平台规格构建应用菜单。
pub fn build_application_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let metadata = about_metadata();
    let mut submenus: Vec<Submenu<R>> = Vec::with_capacity(APPLICATION_MENU.len());
    for spec in APPLICATION_MENU {
        let mut items: Vec<Box<dyn tauri::menu::IsMenuItem<R>>> =
            Vec::with_capacity(spec.items.len());
        for kind in spec.items {
            let item: Box<dyn tauri::menu::IsMenuItem<R>> = match kind {
                ItemKind::About => Box::new(PredefinedMenuItem::about(
                    app,
                    about_label(),
                    Some(metadata.clone()),
                )?),
                ItemKind::Services => Box::new(PredefinedMenuItem::services(app, None)?),
                ItemKind::Hide => Box::new(PredefinedMenuItem::hide(app, None)?),
                ItemKind::HideOthers => Box::new(PredefinedMenuItem::hide_others(app, None)?),
                ItemKind::Quit => Box::new(PredefinedMenuItem::quit(app, None)?),
                ItemKind::Exit => Box::new(MenuItem::with_id(
                    app,
                    EXIT_MENU_ID,
                    "Exit",
                    true,
                    None::<&str>,
                )?),
                ItemKind::Separator => Box::new(PredefinedMenuItem::separator(app)?),
            };
            items.push(item);
        }
        let references: Vec<&dyn tauri::menu::IsMenuItem<R>> =
            items.iter().map(|item| item.as_ref()).collect();
        // 顶层子菜单使用规格里的稳定 id，便于审计与事件路由扩展。
        submenus.push(Submenu::with_id_and_items(
            app,
            spec.id,
            spec.label,
            true,
            &references,
        )?);
    }
    let references: Vec<&dyn tauri::menu::IsMenuItem<R>> = submenus
        .iter()
        .map(|submenu| submenu as &dyn tauri::menu::IsMenuItem<R>)
        .collect();
    Menu::with_items(app, &references)
}

/// 菜单事件路由：只有退出项匹配 `EXIT_MENU_ID`。
pub fn is_exit_menu_id(id: &str) -> bool {
    id == EXIT_MENU_ID
}

/// 统一菜单事件处理：先审计记录稳定 id，再按 id 路由。
///
/// 记录所有菜单动作（含 About）便于诊断"菜单可见但事件未到达"这类平台差异问题。
pub fn handle_menu_event(app: &AppHandle, id: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        state.record_menu_action(id);
    }
    if is_exit_menu_id(id) {
        request_exit(app);
    }
}

/// 统一安全退出入口：菜单 Exit/Quit 与 `quit_app` 命令共用。
///
/// 语义（design §8.3）：先幂等 `stop_runtime()`；成功才退出；失败时记录脱敏错误、
/// 展示失败状态并阻止退出。不得直接 `std::process::exit`，也不得按名称终止进程。
pub fn request_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Err(error) = state.stop_runtime() {
            state.record_failure(&error, false);
            let _ = state.show_failure_window(app);
            return;
        }
    }
    app.exit(0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn about_metadata_is_shared_and_versioned() {
        let metadata = about_metadata();
        assert_eq!(metadata.name.as_deref(), Some(PRODUCT_NAME));
        assert_eq!(metadata.version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
        let credits = metadata.credits.as_deref().unwrap_or_default();
        assert!(credits.contains("DeepSeek Harness"));
        assert!(credits.contains("Node.js"));
        assert!(
            !credits.contains("unknown"),
            "credits 必须从 runtime-lock.json 解析出版本：{credits}"
        );
    }

    #[test]
    fn exit_events_route_only_to_the_exit_id() {
        assert!(is_exit_menu_id(EXIT_MENU_ID));
        assert!(!is_exit_menu_id("help.about"));
        assert!(!is_exit_menu_id(""));
    }

    #[test]
    fn menu_spec_matches_the_platform_convention() {
        if cfg!(target_os = "macos") {
            // macOS：单个应用菜单，标题是产品名，保留 About/Services/Hide/Hide Others/Quit。
            assert_eq!(APPLICATION_MENU.len(), 1);
            let application_menu = &APPLICATION_MENU[0];
            assert_eq!(application_menu.label, PRODUCT_NAME);
            assert_eq!(
                application_menu.items,
                &[
                    ItemKind::About,
                    ItemKind::Separator,
                    ItemKind::Services,
                    ItemKind::Separator,
                    ItemKind::Hide,
                    ItemKind::HideOthers,
                    ItemKind::Separator,
                    ItemKind::Quit,
                ]
            );
        } else {
            // Windows：恰好 File 与 Help；File 只有 Exit，Help 只有 About；
            // 顶层菜单不得重复产品名，也不得出现 macOS 专属项。
            let labels: Vec<&str> = APPLICATION_MENU.iter().map(|spec| spec.label).collect();
            assert_eq!(labels, vec!["File", "Help"]);
            let file = APPLICATION_MENU
                .iter()
                .find(|spec| spec.id == "file")
                .expect("file menu");
            assert_eq!(file.items, &[ItemKind::Exit]);
            let help = APPLICATION_MENU
                .iter()
                .find(|spec| spec.id == "help")
                .expect("help menu");
            assert_eq!(help.items, &[ItemKind::About]);
            for spec in APPLICATION_MENU {
                assert_ne!(spec.label, PRODUCT_NAME, "Windows 顶层菜单不得重复产品名");
                for item in spec.items {
                    assert!(
                        !matches!(
                            item,
                            ItemKind::Services
                                | ItemKind::Hide
                                | ItemKind::HideOthers
                                | ItemKind::Quit
                        ),
                        "Windows 菜单不得包含 macOS 专属项"
                    );
                }
            }
        }
    }

    #[test]
    fn exit_item_uses_a_stable_id() {
        assert_eq!(EXIT_MENU_ID, "file.exit");
        // 非 macOS 菜单必须包含 Exit 项（Windows 的退出路径依赖它）。
        if !cfg!(target_os = "macos") {
            let has_exit = APPLICATION_MENU
                .iter()
                .any(|spec| spec.items.contains(&ItemKind::Exit));
            assert!(has_exit, "非 macOS 菜单必须提供 Exit 项");
        }
    }
}
