// Prevent a console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use cuprum_core::cache;
use cuprum_core::compose::{self, Placement};
use cuprum_core::goo::{
    self, ExposureParams, SCREEN_H, SCREEN_PX_PER_MM_X, SCREEN_PX_PER_MM_Y, SCREEN_W,
};
use cuprum_core::sdcp;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::Manager;

const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(4);
const PRINT_FILENAME: &str = "cuprum-ui.goo";

#[derive(Serialize)]
struct PrinterInfo {
    name: String,
    ip: String,
}

/// Discover the first printer on the LAN. Async + spawn_blocking so the 4s UDP
/// wait runs off the core's main thread (otherwise it freezes the event loop).
#[tauri::command]
async fn discover() -> Result<PrinterInfo, String> {
    let d = tauri::async_runtime::spawn_blocking(|| sdcp::discover_one(DISCOVERY_TIMEOUT))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    Ok(PrinterInfo {
        name: d.data.name,
        ip: d.data.mainboard_ip,
    })
}

#[derive(Serialize)]
struct PreviewResult {
    /// PNG as a data URL, ready for an <img>/Konva image.
    png_data_url: String,
    width_mm: f32,
    height_mm: f32,
    /// Render timing breakdown (shown in the front-end console for diagnosis).
    timings: String,
}

/// Render a Gerber to a preview PNG + its true mm size. Called once per file.
/// Async + spawn_blocking: rasterization is CPU-bound; keep it off the main
/// thread so concurrent renders (reload) don't serialize and the UI stays live.
#[tauri::command]
async fn render_preview(path: String, max_px: u32) -> Result<PreviewResult, String> {
    let (png, info, timings) = tauri::async_runtime::spawn_blocking(move || {
        cache::preview_png(std::path::Path::new(&path), max_px)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
    Ok(PreviewResult {
        png_data_url: format!("data:image/png;base64,{b64}"),
        width_mm: info.width_mm,
        height_mm: info.height_mm,
        timings,
    })
}

#[derive(Deserialize)]
struct PlacementDto {
    path: String,
    /// Top-left of the artwork on the screen, in millimeters.
    x_mm: f32,
    y_mm: f32,
    #[serde(default)]
    rotation_deg: u16,
}

#[derive(Deserialize)]
struct PrintRequest {
    placements: Vec<PlacementDto>,
    mirror: bool,
    invert: bool,
    exposure_s: f32,
    pwm: u16,
}

#[derive(Serialize, Clone)]
struct PrintStatus {
    stage: String,
    message: String,
}

fn emit_status(app: &AppHandle, stage: &str, message: impl Into<String>) {
    let _ = app.emit(
        "print-status",
        PrintStatus {
            stage: stage.to_string(),
            message: message.into(),
        },
    );
}

/// Compose the layout at full resolution, upload, and fire the exposure. Runs on
/// a background thread and streams progress via the `print-status` event.
#[tauri::command]
fn compose_and_print(app: AppHandle, req: PrintRequest) -> Result<(), String> {
    std::thread::spawn(move || {
        if let Err(e) = run_print(&app, req) {
            emit_status(&app, "error", e.to_string());
        }
    });
    Ok(())
}

fn run_print(app: &AppHandle, req: PrintRequest) -> anyhow::Result<()> {
    emit_status(app, "composing", "rendering & composing layout…");
    let placements: Vec<Placement> = req
        .placements
        .iter()
        .map(|p| Placement {
            path: p.path.clone().into(),
            off_x: (p.x_mm * SCREEN_PX_PER_MM_X).round() as i32,
            off_y: (p.y_mm * SCREEN_PX_PER_MM_Y).round() as i32,
            rotation_deg: p.rotation_deg,
        })
        .collect();

    let screen = compose::compose_layout(&placements, req.mirror, req.invert, true)?;
    let params = ExposureParams {
        exposure_time_s: req.exposure_s,
        light_pwm: req.pwm,
    };
    let goo_file = goo::single_layer_exposure(SCREEN_W, SCREEN_H, &screen, params)?;
    let bytes = goo::serialize(&goo_file);

    emit_status(app, "discovering", "finding printer…");
    let device = sdcp::discover_one(DISCOVERY_TIMEOUT)?;

    emit_status(
        app,
        "uploading",
        format!(
            "uploading {:.1} KiB to {}…",
            bytes.len() as f64 / 1024.0,
            device.data.name
        ),
    );
    sdcp::upload_file(&device.data.mainboard_ip, PRINT_FILENAME, &bytes)?;

    let mut session = sdcp::Session::connect(&device)?;
    emit_status(app, "starting", "waiting for printer to be idle…");
    session.wait_until_idle(Duration::from_secs(20))?;
    session.start_print_checked(PRINT_FILENAME, 5)?;
    let _ = session.skip_preheat();

    emit_status(
        app,
        "exposing",
        format!("exposure started: {:.0}s @ pwm {}", req.exposure_s, req.pwm),
    );
    // Drain briefly so skip_preheat flushes; the printer runs the job on its own.
    let drain = std::time::Instant::now() + Duration::from_secs(2);
    while std::time::Instant::now() < drain {
        let _ = session.try_recv()?;
    }
    emit_status(
        app,
        "done",
        "exposure running — UV turns off when time elapses",
    );
    Ok(())
}

/// Abort any running print. Async + spawn_blocking (discover + WS are blocking).
#[tauri::command]
async fn stop_print() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(|| -> anyhow::Result<()> {
        let device = sdcp::discover_one(DISCOVERY_TIMEOUT)?;
        let mut session = sdcp::Session::connect(&device)?;
        session.stop_print()?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

// ---- Project / recents (thin proxies over cuprum-project) ----

/// Path to the recents catalog DB inside the app data dir (created if missing).
fn catalog_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("catalog.sqlite"))
}

fn now_epoch() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Read a project file from the working dir by its archive-relative path.
fn read_workdir_file(working_dir: &str, rel: &str) -> Result<Vec<u8>, String> {
    std::fs::read(Path::new(working_dir).join(rel)).map_err(|e| e.to_string())
}

/// Base dir holding all per-open working directories (under the OS cache dir).
fn working_base(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("working");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// A unique restore-point id: epoch seconds + a process-local counter.
fn new_restore_point_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("rp-{}-{}", now_epoch(), n)
}

/// A freshly chosen, not-yet-existing working-dir path for one open project.
/// Unique by pid + epoch + a process-local monotonic counter, so repeated
/// opens of the same project within one wall-clock second never collide.
fn new_workdir(app: &AppHandle) -> Result<PathBuf, String> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let base = working_base(app)?;
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let name = format!("{}-{}-{}", std::process::id(), now_epoch(), n);
    Ok(base.join(name))
}

#[derive(Serialize)]
struct RecentProjectDto {
    path: String,
    name: String,
    last_opened_at: i64,
    exists: bool,
}

#[tauri::command]
fn list_recent_projects(app: AppHandle) -> Result<Vec<RecentProjectDto>, String> {
    let db = catalog_db_path(&app)?;
    let recents = cuprum_project::list_recent(&db).map_err(|e| e.to_string())?;
    Ok(recents
        .into_iter()
        .map(|r| RecentProjectDto {
            path: r.path,
            name: r.name,
            last_opened_at: r.last_opened_at,
            exists: r.exists,
        })
        .collect())
}

#[tauri::command]
fn create_project(
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenedProjectDto {
    working_dir: String,
    manifest: cuprum_project::Manifest,
}

#[tauri::command]
fn open_project(app: AppHandle, path: String) -> Result<OpenedProjectDto, String> {
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
    Ok(OpenedProjectDto {
        working_dir: workdir.to_string_lossy().to_string(),
        manifest,
    })
}

/// Pack the working dir back into the `.cuprum` container (Ctrl-S / save-as).
#[tauri::command]
fn save_project(working_dir: String, target_path: String) -> Result<(), String> {
    cuprum_project::workdir::pack(Path::new(&working_dir), Path::new(&target_path))
        .map_err(|e| e.to_string())
}

/// Mirror the current manifest into the working dir (called after every mutation
/// so the loose copy stays the live document; basis for crash recovery).
#[tauri::command]
fn write_working_manifest(
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
fn add_design_from_zip(
    working_dir: String,
    zip_path: String,
) -> Result<cuprum_project::manifest::Design, String> {
    cuprum_project::add_design_to_workdir(Path::new(&working_dir), Path::new(&zip_path))
        .map_err(|e| e.to_string())
}

/// List recoverable (dirty) orphan working dirs left by a previous run.
#[tauri::command]
fn scan_recoverable(app: AppHandle) -> Result<Vec<cuprum_project::Orphan>, String> {
    let base = working_base(&app)?;
    let orphans = cuprum_project::workdir::scan_orphans(&base, std::process::id())
        .map_err(|e| e.to_string())?;
    Ok(orphans.into_iter().filter(|o| o.dirty).collect())
}

/// Delete a working dir (clean shutdown / discard / after adopting recovery).
/// Confines deletion to the working base so an IPC caller cannot remove arbitrary
/// paths on the filesystem.
#[tauri::command]
fn cleanup_workdir(app: AppHandle, working_dir: String) -> Result<(), String> {
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
fn make_restore_point(
    working_dir: String,
    label: Option<String>,
) -> Result<cuprum_project::RestorePointMeta, String> {
    let id = new_restore_point_id();
    cuprum_project::history::write(Path::new(&working_dir), &id, label.as_deref(), now_epoch())
        .map_err(|e| e.to_string())
}

/// List restore points (newest first), without their manifest bodies.
#[tauri::command]
fn list_restore_points(
    working_dir: String,
) -> Result<Vec<cuprum_project::RestorePointMeta>, String> {
    cuprum_project::history::list(Path::new(&working_dir)).map_err(|e| e.to_string())
}

/// The manifest captured by a restore point.
#[tauri::command]
fn read_restore_point(working_dir: String, id: String) -> Result<cuprum_project::Manifest, String> {
    cuprum_project::history::read(Path::new(&working_dir), &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn import_zips(
    app: AppHandle,
    path: String,
    zip_paths: Vec<String>,
) -> Result<cuprum_project::Manifest, String> {
    let db = catalog_db_path(&app)?;
    let zips: Vec<PathBuf> = zip_paths.into_iter().map(PathBuf::from).collect();
    cuprum_project::import_zips(&db, Path::new(&path), &zips, now_epoch())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_recent(app: AppHandle, path: String) -> Result<(), String> {
    let db = catalog_db_path(&app)?;
    cuprum_project::remove_recent(&db, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_project_metadata(
    app: AppHandle,
    path: String,
    name: String,
    description: String,
) -> Result<cuprum_project::Manifest, String> {
    let db = catalog_db_path(&app)?;
    cuprum_project::update_project_metadata(&db, Path::new(&path), &name, &description, now_epoch())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn configure_panel(
    app: AppHandle,
    path: String,
    panel: cuprum_project::PanelDoc,
    stackup: cuprum_project::Stackup,
) -> Result<cuprum_project::Manifest, String> {
    let db = catalog_db_path(&app)?;
    cuprum_project::configure_panel(&db, Path::new(&path), &panel, stackup, now_epoch())
        .map_err(|e| e.to_string())
}

// ---- Working-dir gerber inspection (drill holes, SVG geometry) ----

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HoleDto {
    x: f32,
    y: f32,
    d: f32,
}

#[tauri::command]
fn read_drill(working_dir: String, gerber_rel: String) -> Result<Vec<HoleDto>, String> {
    let bytes = read_workdir_file(&working_dir, &gerber_rel)?;
    let holes = cuprum_core::drill::parse_drill(&bytes).map_err(|e| e.to_string())?;
    Ok(holes
        .into_iter()
        .map(|h| HoleDto {
            x: h.x_mm,
            y: h.y_mm,
            d: h.d_mm,
        })
        .collect())
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BBoxDto {
    min_x: f32,
    min_y: f32,
    max_x: f32,
    max_y: f32,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LayerGeometryDto {
    svg_body: String,
    bbox: BBoxDto,
    snap: Vec<[f32; 2]>,
}

#[tauri::command]
fn render_gerber_svg(
    app: AppHandle,
    working_dir: String,
    gerber_rel: String,
) -> Result<LayerGeometryDto, String> {
    let bytes = read_workdir_file(&working_dir, &gerber_rel)?;
    render_or_cache_svg(&app, &bytes)
}

// ---- Copper polygons (2D boolean booleans in Rust core) ----

#[derive(serde::Deserialize)]
struct HoleInput {
    x: f64,
    y: f64,
    d: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PolyDto {
    outer: Vec<[f32; 2]>,
    holes: Vec<Vec<[f32; 2]>>,
}

fn polys_to_dtos(polys: Vec<cuprum_core::geometry::Poly>) -> Vec<PolyDto> {
    polys
        .into_iter()
        .map(|p| PolyDto {
            outer: p.outer,
            holes: p.holes,
        })
        .collect()
}

/// Compute clean, non-overlapping fill polygons (outer ring + holes) for one
/// generic gerber layer (copper, silk, paste, other) with the drill holes
/// subtracted. Thin proxy over `cuprum_core::geometry::layer_polygons`; reads
/// the gerber bytes from the `.cuprum` container like `render_gerber_svg` does.
#[tauri::command]
fn layer_polygons(
    working_dir: String,
    gerber_rel: String,
    holes: Vec<HoleInput>,
) -> Result<Vec<PolyDto>, String> {
    let bytes = read_workdir_file(&working_dir, &gerber_rel)?;
    let holes: Vec<cuprum_core::geometry::Hole> = holes
        .into_iter()
        .map(|h| cuprum_core::geometry::Hole {
            x: h.x,
            y: h.y,
            d: h.d,
        })
        .collect();
    let polys = cuprum_core::geometry::layer_polygons(&bytes, &holes).map_err(|e| e.to_string())?;
    Ok(polys_to_dtos(polys))
}

/// Backwards-compatible alias kept so the original copper wiring keeps working.
#[tauri::command]
fn copper_polygons(
    working_dir: String,
    gerber_rel: String,
    holes: Vec<HoleInput>,
) -> Result<Vec<PolyDto>, String> {
    layer_polygons(working_dir, gerber_rel, holes)
}

/// Compute the soldermask geometry: the board region MINUS the mask openings.
/// The board outline rings are stitched on the frontend from Edge_Cuts (see
/// `boardOutline.ts`) and passed in here as absolute-mm rings (Y up).
#[tauri::command]
fn mask_polygons(
    working_dir: String,
    gerber_rel: String,
    outline_rings: Vec<Vec<[f32; 2]>>,
) -> Result<Vec<PolyDto>, String> {
    let bytes = read_workdir_file(&working_dir, &gerber_rel)?;
    let rings: Vec<Vec<[f64; 2]>> = outline_rings
        .into_iter()
        .map(|ring| {
            ring.into_iter()
                .map(|[x, y]| [x as f64, y as f64])
                .collect()
        })
        .collect();
    let polys = cuprum_core::geometry::mask_polygons(&rings, &bytes).map_err(|e| e.to_string())?;
    Ok(polys_to_dtos(polys))
}

// ---- Artifact disk cache (content-addressed): rendered SVG + 3D mesh ----
//
// Heavy derived artifacts are cached on disk, keyed by a hash of the source
// gerber bytes (+ params), so re-imports / reopens / type toggles are instant.
// Defaults live here as one block — TODO: expose in app settings.
const ARTIFACT_CACHE_MAX_BYTES: u64 = 256 * 1024 * 1024; // 256 MB
const ARTIFACT_CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60); // 7 days

/// The artifact cache directory under the OS app-cache dir, or None if it can't
/// be resolved (then caching is simply skipped).
fn artifact_cache_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("artifacts"))
}

/// Render one gerber's SVG, going through the disk cache. The SVG element-id is
/// derived from the content hash so a cached entry is valid regardless of which
/// layer/index requested it.
fn render_or_cache_svg(app: &AppHandle, bytes: &[u8]) -> Result<LayerGeometryDto, String> {
    let key = cuprum_core::diskcache::key_for(&[b"svg-v1", bytes]);
    let dir = artifact_cache_dir(app);
    if let Some(d) = &dir {
        if let Some(blob) = cuprum_core::diskcache::get(d, &key, ARTIFACT_CACHE_TTL) {
            if let Ok(dto) = serde_json::from_slice::<LayerGeometryDto>(&blob) {
                return Ok(dto);
            }
        }
    }
    let id = format!("ly{}", &key[..8]);
    let g = cuprum_core::svg::render_layer_svg(bytes, &id).map_err(|e| e.to_string())?;
    let dto = LayerGeometryDto {
        svg_body: g.svg_body,
        bbox: BBoxDto {
            min_x: g.bbox.min_x,
            min_y: g.bbox.min_y,
            max_x: g.bbox.max_x,
            max_y: g.bbox.max_y,
        },
        snap: g.snap,
    };
    if let Some(d) = &dir {
        if let Ok(blob) = serde_json::to_vec(&dto) {
            cuprum_core::diskcache::put(
                d,
                &key,
                &blob,
                ARTIFACT_CACHE_MAX_BYTES,
                ARTIFACT_CACHE_TTL,
            );
        }
    }
    Ok(dto)
}

// ---- 3D board mesh (triangulated in Rust, returned as a binary blob) ----
//
// The whole 3D geometry pipeline runs here, off the UI thread, and ships ONE
// binary buffer (positions/normals/indices, per-layer Z baked in). The frontend
// just uploads typed-array views — no booleans, triangulation, SVG parsing, or
// per-hole meshes on the main thread, and no multi-megabyte `JSON.parse`.

/// Map a project `LayerType` to the core mesh role + side.
fn role_side(t: &cuprum_project::LayerType) -> (cuprum_core::mesh::Role, cuprum_core::mesh::Side) {
    use cuprum_core::mesh::{Role, Side};
    use cuprum_project::LayerType as LT;
    match t {
        LT::TopCopper | LT::InnerCopper => (Role::Copper, Side::Top),
        LT::BottomCopper => (Role::Copper, Side::Bottom),
        LT::TopMask => (Role::Mask, Side::Top),
        LT::BottomMask => (Role::Mask, Side::Bottom),
        LT::TopSilk => (Role::Silk, Side::Top),
        LT::BottomSilk => (Role::Silk, Side::Bottom),
        LT::TopPaste => (Role::Paste, Side::Top),
        LT::BottomPaste => (Role::Paste, Side::Bottom),
        LT::EdgeCuts => (Role::Edge, Side::Both),
        LT::Drill => (Role::Drill, Side::Both),
        LT::Other => (Role::Other, Side::Top),
    }
}

/// Byte layout for one mesh buffer inside the blob's data section. Offsets are
/// BYTE offsets into the data section; lengths are ELEMENT counts. Normals share
/// the position length, so only their offset is stored.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SectHdr {
    pos_off: u32,
    pos_len: u32,
    norm_off: u32,
    idx_off: u32,
    idx_len: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LayerHdr {
    key: String,
    kind: u8,
    sect: SectHdr,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct MeshHdr {
    substrate: SectHdr,
    layers: Vec<LayerHdr>,
}

fn append_f32(data: &mut Vec<u8>, v: &[f32]) -> (u32, u32) {
    let off = data.len() as u32;
    data.reserve(v.len() * 4);
    for f in v {
        data.extend_from_slice(&f.to_le_bytes());
    }
    (off, v.len() as u32)
}

fn append_u32(data: &mut Vec<u8>, v: &[u32]) -> (u32, u32) {
    let off = data.len() as u32;
    data.reserve(v.len() * 4);
    for f in v {
        data.extend_from_slice(&f.to_le_bytes());
    }
    (off, v.len() as u32)
}

fn section(data: &mut Vec<u8>, buf: &cuprum_core::mesh::Buffer) -> SectHdr {
    let (pos_off, pos_len) = append_f32(data, &buf.positions);
    let (norm_off, _) = append_f32(data, &buf.normals);
    let (idx_off, idx_len) = append_u32(data, &buf.indices);
    SectHdr {
        pos_off,
        pos_len,
        norm_off,
        idx_off,
        idx_len,
    }
}

/// Pack a [`cuprum_core::mesh::BoardMesh`] into the wire format:
/// `[u32 headerLen][header JSON][pad to 4][data: f32/u32 sections]`.
fn pack_board_mesh(board: cuprum_core::mesh::BoardMesh) -> Vec<u8> {
    let mut data: Vec<u8> = Vec::new();
    let substrate = section(&mut data, &board.substrate);
    let layers: Vec<LayerHdr> = board
        .layers
        .iter()
        .map(|m| LayerHdr {
            key: m.key.clone(),
            kind: m.kind,
            sect: section(&mut data, &m.buffer),
        })
        .collect();
    let header = MeshHdr { substrate, layers };
    let hbytes = serde_json::to_vec(&header).unwrap_or_default();

    let mut out = Vec::with_capacity(4 + hbytes.len() + 4 + data.len());
    out.extend_from_slice(&(hbytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&hbytes);
    while out.len() % 4 != 0 {
        out.push(0); // pad so the data section starts 4-byte aligned (f32/u32 views)
    }
    out.extend_from_slice(&data);
    out
}

/// Return a cached board-mesh blob for `key`, or build it via `build`, cache it,
/// and return. Caching is best-effort (skipped if the cache dir is unavailable).
fn board_mesh_cached(app: &AppHandle, key: &str, build: impl FnOnce() -> Vec<u8>) -> Vec<u8> {
    let dir = artifact_cache_dir(app);
    if let Some(d) = &dir {
        if let Some(blob) = cuprum_core::diskcache::get(d, key, ARTIFACT_CACHE_TTL) {
            return blob;
        }
    }
    let blob = build();
    if let Some(d) = &dir {
        cuprum_core::diskcache::put(d, key, &blob, ARTIFACT_CACHE_MAX_BYTES, ARTIFACT_CACHE_TTL);
    }
    blob
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GerberRef {
    rel: String,
    layer_type: cuprum_project::LayerType,
}

/// Build the 3D board mesh for a COMMITTED project: read each gerber from the
/// working dir. Keys are the gerber rel path (matches the project view's keys).
#[tauri::command]
fn project_board_mesh(
    app: AppHandle,
    working_dir: String,
    gerbers: Vec<GerberRef>,
    // Gerber-rel keys to OMIT from the mesh entirely (hidden drill layers): a
    // hidden drill must remove its holes from the board, not just its barrels —
    // which means re-drilling the substrate, so it's a server-side rebuild.
    excluded_keys: Vec<String>,
) -> Result<tauri::ipc::Response, String> {
    let mut loaded: Vec<(String, cuprum_project::LayerType, Vec<u8>)> = Vec::new();
    for g in &gerbers {
        let bytes = read_workdir_file(&working_dir, &g.rel)?;
        loaded.push((g.rel.clone(), g.layer_type, bytes));
    }
    let excluded: std::collections::HashSet<String> = excluded_keys.into_iter().collect();
    // Cache key: included layers only (rel-path key + type + bytes).
    let mut hasher = cuprum_core::diskcache::Hasher::new();
    hasher.add(b"mesh-v4");
    for (rel, t, bytes) in &loaded {
        if excluded.contains(rel) {
            continue;
        }
        hasher.add(rel.as_bytes());
        hasher.add(format!("{t:?}").as_bytes());
        hasher.add(bytes);
    }
    let blob = board_mesh_cached(&app, &hasher.finish(), || {
        let inputs: Vec<cuprum_core::mesh::LayerInput> = loaded
            .iter()
            .filter(|(rel, _, _)| !excluded.contains(rel))
            .map(|(rel, t, bytes)| {
                let (role, side) = role_side(t);
                cuprum_core::mesh::LayerInput {
                    key: rel.clone(),
                    role,
                    side,
                    bytes,
                }
            })
            .collect();
        pack_board_mesh(cuprum_core::mesh::board_geometry(&inputs))
    });
    Ok(tauri::ipc::Response::new(blob))
}

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
fn display_px_per_mm() -> f32 {
    static CACHE: std::sync::OnceLock<f32> = std::sync::OnceLock::new();
    *CACHE.get_or_init(compute_px_per_mm)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Remove clean (no-unsaved-changes) leftover working dirs from prior runs.
            let handle = app.handle().clone();
            if let Ok(base) = working_base(&handle) {
                let _ = cuprum_project::workdir::gc_clean(&base, std::process::id());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            discover,
            render_preview,
            compose_and_print,
            stop_print,
            list_recent_projects,
            create_project,
            open_project,
            save_project,
            write_working_manifest,
            scan_recoverable,
            cleanup_workdir,
            make_restore_point,
            list_restore_points,
            read_restore_point,
            import_zips,
            remove_recent,
            update_project_metadata,
            configure_panel,
            add_design_from_zip,
            render_gerber_svg,
            copper_polygons,
            layer_polygons,
            mask_polygons,
            project_board_mesh,
            read_drill,
            display_px_per_mm
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cuprum");
}
