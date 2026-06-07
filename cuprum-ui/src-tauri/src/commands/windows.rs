use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};

// ---- Pending open ----

/// Path of a project a double-click / second-launch asked us to open, parked until
/// the frontend is ready to consume it (it calls `take_pending_open` on mount).
#[derive(Default)]
pub(crate) struct PendingOpen(pub(crate) Mutex<Option<String>>);

/// True if `p` looks like a Cuprum project file by extension.
pub(crate) fn is_project_file(p: &Path) -> bool {
    matches!(
        p.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("cu") | Some("cuprum")
    )
}

/// First existing `.cu`/`.cuprum` path among CLI args (skips argv[0]).
pub(crate) fn project_path_from_args(args: &[String]) -> Option<String> {
    args.iter().skip(1).find_map(|a| {
        let p = Path::new(a);
        (is_project_file(p) && p.exists()).then(|| a.clone())
    })
}

/// Park `path` as the pending open and notify the frontend (if it's already up).
pub(crate) fn dispatch_open(app: &AppHandle, path: String) {
    if let Some(state) = app.try_state::<PendingOpen>() {
        *state.0.lock().unwrap() = Some(path.clone());
    }
    let _ = app.emit("open-file", path);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_focus();
    }
}

/// Register `path` with the OS so it shows up in the dock's "Open Recent" menu.
/// Best-effort: any failure is silently ignored (recents are a nicety, not a
/// requirement of opening a project).
#[cfg(target_os = "macos")]
pub(crate) fn record_recent_document(app: &AppHandle, path: String) {
    use objc2_app_kit::NSDocumentController;
    use objc2_foundation::{NSString, NSURL};

    // AppKit's NSDocumentController is main-thread-only; hop onto the main thread.
    let _ = app.run_on_main_thread(move || {
        // Safe: `run_on_main_thread` guarantees we are on the main thread here.
        let Some(mtm) = objc2_foundation::MainThreadMarker::new() else {
            return;
        };
        let url = NSURL::fileURLWithPath(&NSString::from_str(&path));
        let controller = NSDocumentController::sharedDocumentController(mtm);
        controller.noteNewRecentDocumentURL(&url);
    });
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn record_recent_document(_app: &AppHandle, _path: String) {}

// ---- Real display DPI (macOS native, cached once per launch) ----

/// CSS reference: 96 CSS px == 1 inch == 25.4 mm.
const REF_PX_PER_MM: f32 = 96.0 / 25.4;

/// Compute the display's true CSS-pixels-per-millimetre from CoreGraphics.
///
/// In a macOS WebView, 1 CSS px == 1 AppKit point.
/// `CGDisplayPixelsWide` returns the logical width in points (i.e. CSS px),
/// and `CGDisplayScreenSize` returns the physical size in millimetres from
/// the display's EDID.  Dividing gives a value that already accounts for the
/// user's "Scaled resolution" choice — no devicePixelRatio math needed.
fn compute_px_per_mm() -> f32 {
    #[cfg(target_os = "macos")]
    {
        use core_graphics::display::CGDisplay;

        let d = CGDisplay::main();
        // pixels_wide() returns the logical (point-space) width — same as CSS px.
        let px = d.pixels_wide() as f64;
        // screen_size() returns CGSize { width, height } in millimetres (from EDID).
        let size = d.screen_size();
        let mm = size.width;
        if mm > 1.0 && px > 1.0 {
            let v = (px / mm) as f32;
            // Sanity clamp: typical displays are ~2.5–6 css-px/mm.
            if v.is_finite() && (1.0_f32..20.0_f32).contains(&v) {
                return v;
            }
        }
    }
    REF_PX_PER_MM
}

/// Return the host display's CSS-pixels-per-millimetre, cached once per launch.
/// On non-macOS or when EDID data is unavailable the CSS reference value is used.
#[tauri::command]
pub(crate) fn display_px_per_mm() -> f32 {
    static CACHE: std::sync::OnceLock<f32> = std::sync::OnceLock::new();
    *CACHE.get_or_init(compute_px_per_mm)
}

/// Hand the frontend the project path a double-click/relaunch queued (and clear
/// it), so a cold start opens the file. Returns null when there's nothing pending.
#[tauri::command]
pub(crate) fn take_pending_open(state: tauri::State<PendingOpen>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// Open (or focus) the separate "Add design to panel" window. Same bundle as the
/// main window; the SPA branches on the window label. Title is set by the JS side
/// (localised), so we use a neutral one here.
#[tauri::command]
pub(crate) fn open_add_design_window(app: AppHandle) -> Result<(), String> {
    use tauri::{PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window("add-design") {
        // May still be hidden (first snapshot pending) — show before focusing so a
        // repeat open reveals it immediately instead of waiting on the JS path.
        let _ = w.show();
        return w.set_focus().map_err(|e| e.to_string());
    }
    let win = WebviewWindowBuilder::new(&app, "add-design", WebviewUrl::App("index.html".into()))
        .title("Cuprum")
        .inner_size(980.0, 760.0)
        .min_inner_size(720.0, 520.0)
        .resizable(true)
        .center()
        .focused(true)
        // Created hidden; the SPA reveals it once content has rendered (show-on-ready)
        // so it never flashes the blank webview + boot spinner.
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    // Center the window over the main window so on multi-monitor setups it opens
    // on the same screen the user is working on, not the primary one. All physical
    // coords (no scale-factor mismatch); falls back to the builder's .center() if
    // the main window's geometry isn't available.
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(pos), Ok(main_size), Ok(child_size)) =
            (main.outer_position(), main.outer_size(), win.outer_size())
        {
            let x = pos.x + (main_size.width as i32 - child_size.width as i32) / 2;
            let y = pos.y + (main_size.height as i32 - child_size.height as i32) / 2;
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
    Ok(())
}

/// Open (or focus) a per-design inspector window. Label `inspector-<design_id>`,
/// so several designs can be inspected at once; reopening the same design focuses
/// the existing window. Same bundle as the main window; the SPA branches on the
/// label. Title is set (localised) by the JS side.
#[tauri::command]
pub(crate) fn open_inspector_window(app: AppHandle, design_id: String) -> Result<(), String> {
    use tauri::{PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
    // Separator is a hyphen, not a colon: a ':' in a window label is silently
    // rejected by WebView2 on Windows and the webview loads a blank page (the
    // label is otherwise a valid Tauri label on macOS). See the matching prefix
    // in main.tsx / main.rs and the capability glob in capabilities/default.json.
    let label = format!("inspector-{design_id}");
    if let Some(w) = app.get_webview_window(&label) {
        // May still be hidden (first snapshot pending) — show before focusing so a
        // repeat open reveals it immediately instead of waiting on the JS path.
        let _ = w.show();
        return w.set_focus().map_err(|e| e.to_string());
    }
    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("Cuprum")
        .inner_size(1100.0, 820.0)
        .min_inner_size(820.0, 560.0)
        .resizable(true)
        .center()
        .focused(true)
        // Created hidden; the SPA reveals it once content has rendered (show-on-ready)
        // so it never flashes the blank webview + boot spinner.
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    // Center over the main window so it opens on the screen the user is on.
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(pos), Ok(main_size), Ok(child_size)) =
            (main.outer_position(), main.outer_size(), win.outer_size())
        {
            let x = pos.x + (main_size.width as i32 - child_size.width as i32) / 2;
            let y = pos.y + (main_size.height as i32 - child_size.height as i32) / 2;
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
    Ok(())
}

/// Open (or focus) the drilling-operation window. Singleton label `drill`; same
/// bundle as the main window, the SPA branches on the label. The drill UI drives the
/// machine directly (events + invoke are process-global) and receives the project as
/// a pushed snapshot. Title is set (localised) by the JS side.
#[tauri::command]
pub(crate) fn open_drill_window(app: AppHandle) -> Result<(), String> {
    use tauri::{PhysicalPosition, WebviewUrl, WebviewWindowBuilder};
    if let Some(w) = app.get_webview_window("drill") {
        // May still be hidden (first snapshot pending) — show before focusing so a
        // repeat open reveals it immediately instead of waiting on the JS path.
        let _ = w.show();
        return w.set_focus().map_err(|e| e.to_string());
    }
    let win = WebviewWindowBuilder::new(&app, "drill", WebviewUrl::App("index.html".into()))
        .title("Cuprum")
        .inner_size(1100.0, 820.0)
        .min_inner_size(820.0, 560.0)
        .resizable(true)
        .center()
        .focused(true)
        // Created hidden; the SPA reveals it once content has rendered (show-on-ready)
        // so it never flashes the blank webview + boot spinner.
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    // Center over the main window so it opens on the screen the user is on.
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(pos), Ok(main_size), Ok(child_size)) =
            (main.outer_position(), main.outer_size(), win.outer_size())
        {
            let x = pos.x + (main_size.width as i32 - child_size.width as i32) / 2;
            let y = pos.y + (main_size.height as i32 - child_size.height as i32) / 2;
            let _ = win.set_position(PhysicalPosition::new(x, y));
        }
    }
    Ok(())
}
