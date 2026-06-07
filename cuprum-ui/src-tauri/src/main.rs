// Prevent a console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

use std::path::PathBuf;

use tauri::menu::{AboutMetadata, Menu, MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, WindowEvent};
// `RunEvent::Opened` only exists on macOS (Apple-event file open); gate the import
// so the workspace still compiles on Linux/Windows CI.
#[cfg(target_os = "macos")]
use tauri::RunEvent;

/// Localised labels for the native application menu, supplied by the frontend.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct MenuLabels {
    edit: String,
    window: String,
    check_updates: String,
}

use commands::project::working_base;
use commands::windows::{dispatch_open, project_path_from_args, PendingOpen};
// `is_project_file` is only used in the macOS-only `RunEvent::Opened` arm below;
// gate the import so non-macOS CI doesn't flag it as unused under `-D warnings`.
#[cfg(target_os = "macos")]
use commands::windows::is_project_file;

/// Directory for per-operation trace files (sibling of the artifact cache).
/// Falls back to the OS temp dir if the app cache dir can't be resolved.
pub(crate) fn traces_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_cache_dir()
        .map(|d: PathBuf| d.join("traces"))
        .unwrap_or_else(|_| std::env::temp_dir().join("cuprum-traces"))
}

/// English fallback labels used at startup before the frontend pushes i18n strings.
/// Must match the `fallbackLng: "en"` value in the i18next config.
fn default_menu_labels() -> MenuLabels {
    MenuLabels {
        edit: "Edit".into(),
        window: "Window".into(),
        check_updates: "Check for Updates\u{2026}".into(),
    }
}

/// Build the application menu from the provided localised labels.
/// The structure (app submenu + edit + window) never changes; only the three
/// custom label strings vary with the UI language.
fn build_app_menu<R: Runtime>(
    handle: &AppHandle<R>,
    labels: &MenuLabels,
) -> tauri::Result<Menu<R>> {
    let app_b = SubmenuBuilder::new(handle, "Cuprum")
        .about(Some(AboutMetadata::default()))
        .separator()
        .text("check-updates", &labels.check_updates)
        .separator();
    // Services/Hide/Show All are macOS-only predefined items (cfg'd shadowing keeps
    // `app_b` un-`mut` so non-macOS builds don't trip the unused_mut lint).
    #[cfg(target_os = "macos")]
    let app_b = app_b
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator();
    let app_menu = app_b.quit().build()?;

    let edit_menu = SubmenuBuilder::new(handle, &labels.edit)
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let window_menu = SubmenuBuilder::new(handle, &labels.window)
        .minimize()
        .maximize()
        .separator()
        .close_window()
        .build()?;

    MenuBuilder::new(handle)
        .items(&[&app_menu, &edit_menu, &window_menu])
        .build()
}

/// Replace the application menu with newly localised labels sent from the frontend.
/// Called on mount and whenever the UI language changes.
#[tauri::command]
fn set_app_menu(app: AppHandle, labels: MenuLabels) -> Result<(), String> {
    let menu = build_app_menu(&app, &labels).map_err(|e| e.to_string())?;
    app.set_menu(menu).map_err(|e| e.to_string())?;
    Ok(())
}

fn main() {
    let app = tauri::Builder::default()
        .manage(PendingOpen::default())
        .manage(commands::machine::MachineState::default())
        .manage(commands::drill_run::DrillJob::default())
        .menu(|handle| build_app_menu(handle, &default_menu_labels()))
        .on_menu_event(|app, event| {
            // Manual "Check for Updates…" → the frontend runs a loud check (surfaces
            // "up to date"/errors, unlike the silent startup check).
            if event.id().as_ref() == "check-updates" {
                let _ = app.emit("menu://check-updates", ());
            }
        })
        .on_window_event(|window, event| {
            // When the main window closes (app quit), tear down any child
            // windows so they don't linger as orphans keeping the app alive.
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { .. } = event {
                    for (label, w) in window.app_handle().webview_windows() {
                        if label.starts_with("inspector-")
                            || label == "add-design"
                            || label == "drill"
                            || label == "console"
                        {
                            let _ = w.close();
                        }
                    }
                }
            }
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Single-instance: a second launch (Win/Linux file double-click passes the
        // path in argv) forwards its args here instead of opening a new window.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = project_path_from_args(&argv) {
                dispatch_open(app, path);
            }
        }))
        .setup(|app| {
            // Remove clean (no-unsaved-changes) leftover working dirs from prior runs.
            let handle = app.handle().clone();
            if let Ok(base) = working_base(&handle) {
                let _ = cuprum_project::workdir::gc_clean(&base, std::process::id());
            }
            // Cold start: this process was launched with a project path in argv.
            if let Some(path) = project_path_from_args(&std::env::args().collect::<Vec<_>>()) {
                if let Some(state) = app.try_state::<PendingOpen>() {
                    *state.0.lock().unwrap() = Some(path);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::printer::discover,
            commands::printer::render_preview,
            commands::printer::compose_and_print,
            commands::printer::stop_print,
            commands::project::list_recent_projects,
            commands::project::create_project,
            commands::project::open_project,
            commands::project::save_project,
            commands::project::write_working_manifest,
            commands::project::scan_recoverable,
            commands::project::cleanup_workdir,
            commands::project::make_restore_point,
            commands::project::list_restore_points,
            commands::project::read_restore_point,
            commands::project::remove_recent,
            commands::project::update_project_metadata,
            commands::project::read_project_manifest,
            commands::project::set_recent_verdict,
            commands::project::add_design_from_zip,
            commands::render::render_gerber_svg,
            commands::render::render_layers_svg,
            commands::render::render_design_preview,
            commands::render::copper_polygons,
            commands::render::layer_polygons,
            commands::render::mask_polygons,
            commands::board::project_board_mesh,
            commands::board::project_board_metrics,
            commands::render::read_drill,
            commands::windows::display_px_per_mm,
            commands::windows::take_pending_open,
            commands::windows::open_add_design_window,
            commands::windows::open_console_window,
            commands::windows::open_inspector_window,
            commands::windows::open_drill_window,
            set_app_menu,
            commands::machine::list_serial_ports,
            commands::machine::machine_connect,
            commands::machine::machine_disconnect,
            commands::machine::machine_jog,
            commands::machine::machine_jog_to,
            commands::machine::machine_jog_cancel,
            commands::machine::machine_set_zero,
            commands::machine::machine_home,
            commands::machine::machine_home_await,
            commands::machine::machine_unlock,
            commands::machine::machine_spindle,
            commands::machine::machine_probe_z,
            commands::machine::machine_send,
            commands::machine::machine_send_await_ok,
            commands::machine::machine_soft_reset,
            commands::machine::machine_feed_hold,
            commands::machine::machine_cycle_start,
            commands::machine::machine_override,
            commands::machine::machine_is_connected,
            commands::machine::machine_reattach,
            commands::drill_run::drill_run_start,
            commands::drill_run::drill_run_pause,
            commands::drill_run::drill_run_resume,
            commands::drill_run::drill_run_confirm_tool_change,
            commands::drill_run::drill_run_stop,
            commands::drill_run::drill_run_estop,
            commands::drill_run::drill_run_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building Cuprum");

    app.run(move |_app_handle, _event| {
        // macOS delivers a double-clicked file as an Apple-event → RunEvent::Opened.
        // The variant only exists on macOS, so gate the whole arm.
        #[cfg(target_os = "macos")]
        if let RunEvent::Opened { urls } = _event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    if is_project_file(&path) {
                        dispatch_open(_app_handle, path.to_string_lossy().into_owned());
                    }
                }
            }
        }
    });
}
