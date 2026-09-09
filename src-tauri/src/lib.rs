mod app_state;
mod error;
mod logging;
mod paths;
mod sidecar;
mod webview;

use app_state::AppState;
use std::sync::Arc;
use tauri::menu::{AboutMetadataBuilder, Menu, PredefinedMenuItem, Submenu};
use tauri::{
    webview::NewWindowResponse, AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder,
};
use webview::{NavigationDecision, WebviewPolicy};

#[used]
#[cfg(feature = "poc-e2e")]
static BUILD_PROFILE_MARKER: &str = "deepshell-build-profile:poc-e2e";

#[used]
#[cfg(not(feature = "poc-e2e"))]
static BUILD_PROFILE_MARKER: &str = "deepshell-build-profile:release";

#[tauri::command]
fn runtime_status(state: State<'_, AppState>) -> sidecar::RuntimeSnapshot {
    state.snapshot()
}

#[tauri::command]
async fn restart_runtime(app: AppHandle) -> Result<(), String> {
    let worker = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = worker.state::<AppState>();
        state.restart_runtime(&worker).map_err(|error| {
            state.record_failure(&error, false);
            let _ = state.show_failure_window(&worker);
            format!("{}: {}", error.code(), error.user_message())
        })?;
        AppState::start_monitor(worker.clone());
        Ok(())
    })
    .await
    .map_err(|error| format!("runtime_task_failed: {error}"))?
}

#[tauri::command]
fn open_logs_directory(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state
        .open_logs_directory(&app)
        .map_err(|error| format!("{}: {}", error.code(), error.user_message()))
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    state.stop_runtime().map_err(|error| {
        state.record_failure(&error, false);
        let _ = state.show_failure_window(&app);
        format!("{}: {}", error.code(), error.user_message())
    })?;
    app.exit(0);
    Ok(())
}

#[cfg(feature = "poc-e2e")]
#[tauri::command]
fn poc_e2e_stop_runtime(state: State<'_, AppState>) -> Result<(), String> {
    state
        .stop_runtime()
        .map_err(|error| format!("{}: {}", error.code(), error.user_message()))
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(feature = "poc-e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    let application = builder
        .menu(|app| {
            let about = AboutMetadataBuilder::new()
                .name(Some("DeepShell Agent"))
                .version(Some(env!("CARGO_PKG_VERSION")))
                .credits(Some(
                    "A desktop agent powered by DeepSeek Harness.\nNode.js 24.20.0\nDeepSeek Harness 0.1.2-rc.1",
                ))
                .build();
            let application_menu = Submenu::with_items(
                app,
                "DeepShell Agent",
                true,
                &[
                    &PredefinedMenuItem::about(app, None, Some(about))?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::services(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::hide(app, None)?,
                    &PredefinedMenuItem::hide_others(app, None)?,
                    &PredefinedMenuItem::separator(app)?,
                    &PredefinedMenuItem::quit(app, None)?,
                ],
            )?;
            Menu::with_items(app, &[&application_menu])
        })
        .on_window_event(|window, event| {
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    if let Err(error) = state.stop_runtime() {
                        state.record_failure(&error, false);
                        let _ = state.show_failure_window(window.app_handle());
                        return;
                    }
                }
                window.app_handle().exit(0);
            }
        })
        .plugin(tauri_plugin_single_instance::init(
            |app, _arguments, _cwd| {
                if let Some(state) = app.try_state::<AppState>() {
                    let _ = state.show_for_second_instance(app);
                }
            },
        ))
        .setup(|app| {
            let policy = Arc::new(WebviewPolicy::default());
            let navigation_policy = Arc::clone(&policy);
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("DeepShell Agent")
                .inner_size(1280.0, 900.0)
                .resizable(true)
                .visible(false)
                .on_navigation(move |url| match navigation_policy.classify(url) {
                    NavigationDecision::AllowBootstrap | NavigationDecision::AllowDsh => true,
                    NavigationDecision::OpenExternal => {
                        let _ = webview::open_external(url);
                        false
                    }
                    NavigationDecision::Block => false,
                })
                .on_new_window(|url, _features| {
                    if matches!(url.scheme(), "http" | "https") {
                        let _ = webview::open_external(&url);
                    }
                    NewWindowResponse::Deny
                })
                .build()?;
            let state = AppState::bootstrap(
                app.path().app_data_dir()?,
                app.path().resource_dir()?,
                policy,
            )?;
            app.manage(state);
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<AppState>();
                if let Err(error) = state.start_runtime(&handle) {
                    state.record_failure(&error, true);
                    let _ = state.show_failure_window(&handle);
                } else {
                    AppState::start_monitor(handle.clone());
                }
            });
            Ok(())
        })
        ;
    #[cfg(feature = "poc-e2e")]
    let application = application.invoke_handler(tauri::generate_handler![
        runtime_status,
        restart_runtime,
        open_logs_directory,
        quit_app,
        poc_e2e_stop_runtime
    ]);
    #[cfg(not(feature = "poc-e2e"))]
    let application = application.invoke_handler(tauri::generate_handler![
        runtime_status,
        restart_runtime,
        open_logs_directory,
        quit_app
    ]);
    let application = application
        .build(tauri::generate_context!())
        .expect("DeepShell Agent 初始化失败");

    application.run(|app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } => {
            if let Some(state) = app.try_state::<AppState>() {
                if let Err(error) = state.stop_runtime() {
                    state.record_failure(&error, false);
                    api.prevent_exit();
                    let _ = state.show_failure_window(app);
                }
            }
        }
        tauri::RunEvent::Exit => {
            // macOS 的外部 terminate Apple Event 可能直接进入 event-loop 退出阶段。
            // 在进程真正结束前再次执行幂等清理，避免遗留 Sidecar。
            if let Some(state) = app.try_state::<AppState>() {
                if let Err(error) = state.stop_runtime() {
                    state.record_failure(&error, false);
                }
            }
        }
        _ => {}
    });
}
