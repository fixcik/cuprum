use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::commands::windows::record_recent_document;
use crate::traces_dir;

// ---- Project / recents (thin proxies over cuprum-project) ----

/// Path to the recents catalog DB inside the app data dir (created if missing).
pub(crate) fn catalog_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("catalog.sqlite"))
}

pub(crate) fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Read a project file from the working dir by its archive-relative path. `rel`
/// comes from the manifest (via IPC), so reject anything that could escape the
/// working dir — absolute paths, drive prefixes, or `..` components.
pub(crate) fn read_workdir_file(working_dir: &str, rel: &str) -> Result<Vec<u8>, String> {
    let p = Path::new(rel);
    let unsafe_path = p.is_absolute()
        || p.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        });
    if unsafe_path {
        return Err(format!("unsafe relative path: {rel}"));
    }
    std::fs::read(Path::new(working_dir).join(rel)).map_err(|e| e.to_string())
}

/// Resolve a working-dir path from IPC and verify it sits inside the managed
/// working base, so a spoofed `working_dir` can't make us write/read elsewhere.
/// Returns the canonical path.
pub(crate) fn confined_workdir(app: &AppHandle, working_dir: &str) -> Result<PathBuf, String> {
    let base = working_base(app)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let wd = Path::new(working_dir)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !wd.starts_with(&base) {
        return Err("refusing to operate outside the working base".to_string());
    }
    Ok(wd)
}

/// Base dir holding all per-open working directories (under the OS cache dir).
pub(crate) fn working_base(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("working");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A unique restore-point id: epoch seconds + a process-local counter.
pub(crate) fn new_restore_point_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("rp-{}-{}", now_epoch(), n)
}

/// A freshly chosen, not-yet-existing working-dir path for one open project.
/// Unique by pid + epoch + a process-local monotonic counter, so repeated
/// opens of the same project within one wall-clock second never collide.
pub(crate) fn new_workdir(app: &AppHandle) -> Result<PathBuf, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let base = working_base(app)?;
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = format!("{}-{}-{}", std::process::id(), now_epoch(), n);
    Ok(base.join(name))
}

#[derive(Serialize)]
pub(crate) struct RecentProjectDto {
    pub path: String,
    pub name: String,
    pub last_opened_at: i64,
    pub exists: bool,
    /// Number of designs (Home card footer); 0 for projects catalogued before
    /// stats were tracked, until next open/save.
    pub design_count: i64,
    /// Panel blank size in mm; null until the panel is configured.
    pub width_mm: Option<f64>,
    pub height_mm: Option<f64>,
    /// Cached panel feasibility verdict ("ok"/"warn"/"block"); null until computed.
    pub panel_verdict: Option<String>,
    /// Hash of the capability profile used to compute `panel_verdict`; null until set.
    pub profile_hash: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenedProjectDto {
    pub working_dir: String,
    pub manifest: cuprum_project::Manifest,
}

/// DTO returned by `add_design_from_zip`: the new Design plus an optional trace
/// session id. The session stays open so subsequent per-card precompute commands
/// can route their operations into the same trace file.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddedDesignDto {
    pub design: cuprum_project::manifest::Design,
    pub trace_session: Option<u64>,
}

#[tauri::command]
pub(crate) fn list_recent_projects(app: AppHandle) -> Result<Vec<RecentProjectDto>, String> {
    let db = catalog_db_path(&app)?;
    let recents = cuprum_project::list_recent(&db).map_err(|e| e.to_string())?;
    Ok(recents
        .into_iter()
        .map(|r| RecentProjectDto {
            path: r.path,
            name: r.name,
            last_opened_at: r.last_opened_at,
            exists: r.exists,
            design_count: r.design_count,
            width_mm: r.width_mm,
            height_mm: r.height_mm,
            panel_verdict: r.panel_verdict,
            profile_hash: r.profile_hash,
        })
        .collect())
}

#[tauri::command]
pub(crate) fn create_project(
    app: AppHandle,
    save_path: String,
    name: String,
    zip_paths: Vec<String>,
) -> Result<cuprum_project::Manifest, String> {
    let db = catalog_db_path(&app)?;
    let zips: Vec<PathBuf> = zip_paths.into_iter().map(PathBuf::from).collect();
    cuprum_project::create_project(&db, Path::new(&save_path), &name, &zips, now_epoch())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn open_project(app: AppHandle, path: String) -> Result<OpenedProjectDto, String> {
    let db = catalog_db_path(&app)?;
    // Reads the manifest, validates existence, and records the recent entry.
    let manifest = cuprum_project::open_project(&db, Path::new(&path), now_epoch())
        .map_err(|e| e.to_string())?;
    let workdir = new_workdir(&app)?;
    let marker = cuprum_project::SessionMarker {
        source_path: path.clone(),
        pid: std::process::id(),
        opened_at: now_epoch(),
    };
    cuprum_project::workdir::extract(Path::new(&path), &workdir, &marker)
        .map_err(|e| e.to_string())?;
    // Best-effort: surface this project in the macOS dock "Open Recent" menu.
    record_recent_document(&app, path.clone());
    Ok(OpenedProjectDto {
        working_dir: workdir.to_string_lossy().to_string(),
        manifest,
    })
}

/// Pack the working dir back into the `.cuprum` container (Ctrl-S / save-as).
#[tauri::command]
pub(crate) fn save_project(
    app: tauri::AppHandle,
    working_dir: String,
    target_path: String,
) -> Result<(), String> {
    // Confine the working dir to the managed base, like the other IPC commands,
    // so a spoofed call can't pack an arbitrary directory.
    let wd = confined_workdir(&app, &working_dir)?;
    cuprum_core::trace::operation("flush", &traces_dir(&app), || {
        cuprum_project::workdir::pack(&wd, Path::new(&target_path))
    })
    .map_err(|e| e.to_string())?;
    // Keep the Home-card stats (design count + panel size) fresh after edits.
    // Best-effort: never fail a save because the catalog refresh hiccupped.
    if let Ok(db) = catalog_db_path(&app) {
        let _ = cuprum_project::refresh_recent_stats(&db, Path::new(&target_path));
    }
    Ok(())
}

/// Mirror the current manifest into the working dir (called after every mutation
/// so the loose copy stays the live document; basis for crash recovery).
#[tauri::command]
pub(crate) fn write_working_manifest(
    working_dir: String,
    manifest: cuprum_project::Manifest,
) -> Result<(), String> {
    cuprum_project::workdir::write_manifest(Path::new(&working_dir), &manifest)
        .map_err(|e| e.to_string())
}

/// Copy one source ZIP into the open project's working dir as a new Design
/// (auto-classified). Returns the Design for the UI to merge into the manifest;
/// the UI then persists via write_working_manifest + save_project (autosave),
/// which repacks the freshly-copied gerbers into the `.cuprum`.
#[tauri::command]
pub(crate) fn add_design_from_zip(
    app: AppHandle,
    working_dir: String,
    zip_path: String,
) -> Result<AddedDesignDto, String> {
    let wd = confined_workdir(&app, &working_dir)?;
    let traces = traces_dir(&app);
    let sid = cuprum_core::trace::begin_session("load", &traces);
    let design = cuprum_core::trace::operation_in_session(sid, "import", &traces, || {
        cuprum_project::add_design_to_workdir(&wd, Path::new(&zip_path))
    })
    .map_err(|e| e.to_string())?;
    Ok(AddedDesignDto {
        design,
        trace_session: sid,
    })
}

/// List recoverable (dirty) orphan working dirs left by a previous run.
#[tauri::command]
pub(crate) fn scan_recoverable(app: AppHandle) -> Result<Vec<cuprum_project::Orphan>, String> {
    let base = working_base(&app)?;
    let orphans = cuprum_project::workdir::scan_orphans(&base, std::process::id())
        .map_err(|e| e.to_string())?;
    Ok(orphans.into_iter().filter(|o| o.dirty).collect())
}

/// Delete a working dir (clean shutdown / discard / after adopting recovery).
/// Confines deletion to the working base so an IPC caller cannot remove arbitrary
/// paths on the filesystem.
#[tauri::command]
pub(crate) fn cleanup_workdir(app: AppHandle, working_dir: String) -> Result<(), String> {
    let base = working_base(&app)?;
    let path = Path::new(&working_dir);
    // Resolve `..`/symlinks before the containment check. A path that no longer
    // exists (already cleaned) canonicalizes to Err -> nothing to do.
    match (path.canonicalize(), base.canonicalize()) {
        (Ok(canonical), Ok(base_canonical)) => {
            if !canonical.starts_with(&base_canonical) {
                return Err("refusing to remove path outside the working base".to_string());
            }
            std::fs::remove_dir_all(&canonical).map_err(|e| e.to_string())
        }
        _ => Ok(()),
    }
}

/// Create a restore point from the working dir's current manifest.
#[tauri::command]
pub(crate) fn make_restore_point(
    working_dir: String,
    label: Option<String>,
    auto: bool,
) -> Result<cuprum_project::RestorePointMeta, String> {
    let id = new_restore_point_id();
    cuprum_project::history::write(
        Path::new(&working_dir),
        &id,
        label.as_deref(),
        now_epoch(),
        auto,
    )
    .map_err(|e| e.to_string())
}

/// List restore points (newest first), without their manifest bodies.
#[tauri::command]
pub(crate) fn list_restore_points(
    working_dir: String,
) -> Result<Vec<cuprum_project::RestorePointMeta>, String> {
    cuprum_project::history::list(Path::new(&working_dir)).map_err(|e| e.to_string())
}

/// The manifest captured by a restore point.
#[tauri::command]
pub(crate) fn read_restore_point(
    working_dir: String,
    id: String,
) -> Result<cuprum_project::Manifest, String> {
    cuprum_project::history::read(Path::new(&working_dir), &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn remove_recent(app: AppHandle, path: String) -> Result<(), String> {
    let db = catalog_db_path(&app)?;
    cuprum_project::remove_recent(&db, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub(crate) fn update_project_metadata(
    app: AppHandle,
    path: String,
    name: String,
    description: String,
) -> Result<cuprum_project::Manifest, String> {
    let db = catalog_db_path(&app)?;
    cuprum_project::update_project_metadata(&db, Path::new(&path), &name, &description, now_epoch())
        .map_err(|e| e.to_string())
}

/// Read a project's manifest straight from its `.cuprum` file (no working dir) so
/// the recents "edit name/description" dialog can prefill without opening it.
#[tauri::command]
pub(crate) fn read_project_manifest(path: String) -> Result<cuprum_project::Manifest, String> {
    cuprum_project::read_project_manifest(Path::new(&path)).map_err(|e| e.to_string())
}

/// Persist the panel verdict and profile hash into the recents catalog for
/// the given project path, WITHOUT touching `last_opened_at` or stat columns.
/// Called by the frontend once the panel verdict is fully computed (all board
/// sizes and metrics resolved). Best-effort: silently no-ops if the path isn't
/// in the catalog.
#[tauri::command]
pub(crate) fn set_recent_verdict(
    app: AppHandle,
    path: String,
    verdict: String,
    profile_hash: String,
) -> Result<(), String> {
    let db = catalog_db_path(&app)?;
    cuprum_project::set_recent_verdict(&db, &path, &verdict, &profile_hash)
        .map_err(|e| e.to_string())
}
