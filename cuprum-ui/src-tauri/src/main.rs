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

#[tauri::command]
fn open_project(app: AppHandle, path: String) -> Result<cuprum_project::Manifest, String> {
    let db = catalog_db_path(&app)?;
    cuprum_project::open_project(&db, Path::new(&path), now_epoch()).map_err(|e| e.to_string())
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

// ---- Staging import (classify + SVG-render, no container write) ----

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HoleDto {
    x: f32,
    y: f32,
    d: f32,
}

#[tauri::command]
fn read_drill(path: String, gerber_rel: String) -> Result<Vec<HoleDto>, String> {
    let bytes = cuprum_project::container::read_entry(Path::new(&path), &gerber_rel)
        .map_err(|e| e.to_string())?;
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedFileDto {
    source_zip: String,
    filename: String,
    layer_type: cuprum_project::LayerType,
    svg_body: Option<String>,
    bbox: Option<BBoxDto>,
    snap: Vec<[f32; 2]>,
    error: Option<String>,
    /// Drill holes parsed from THIS file (empty for non-drill files), so the UI
    /// can toggle each drill layer's holes independently.
    holes: Vec<HoleDto>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedImportDto {
    files: Vec<StagedFileDto>,
    holes: Vec<HoleDto>,
}

#[tauri::command]
fn stage_import(zip_paths: Vec<String>) -> Result<StagedImportDto, String> {
    let mut files = Vec::new();
    let mut holes: Vec<HoleDto> = Vec::new();
    for zip in &zip_paths {
        let imported = cuprum_project::import::read_zip_gerbers(std::path::Path::new(zip))
            .map_err(|e| e.to_string())?;
        for (idx, (filename, bytes)) in imported.gerbers.iter().enumerate() {
            let layer_type = cuprum_project::layer::classify(filename);
            let is_drill = matches!(layer_type, cuprum_project::LayerType::Drill);
            let mut file_holes: Vec<HoleDto> = Vec::new();
            let mut drill_error = None;
            if is_drill {
                match cuprum_core::drill::parse_drill(bytes) {
                    Ok(hs) => {
                        file_holes = hs
                            .into_iter()
                            .map(|h| HoleDto {
                                x: h.x_mm,
                                y: h.y_mm,
                                d: h.d_mm,
                            })
                            .collect()
                    }
                    Err(e) => drill_error = Some(e.to_string()),
                }
            }
            holes.extend(file_holes.iter().cloned());
            let id = format!("stage-{}-{}", files.len(), idx);
            // Drill files aren't gerbers — skip the SVG render and carry the drill
            // parse error (if any) in `error` instead.
            let (svg_body, bbox, snap, error) = if is_drill {
                (None, None, Vec::new(), drill_error)
            } else {
                match cuprum_core::svg::render_layer_svg(bytes, &id) {
                    Ok(g) => (
                        Some(g.svg_body),
                        Some(BBoxDto {
                            min_x: g.bbox.min_x,
                            min_y: g.bbox.min_y,
                            max_x: g.bbox.max_x,
                            max_y: g.bbox.max_y,
                        }),
                        g.snap,
                        None,
                    ),
                    Err(e) => (None, None, Vec::new(), Some(e.to_string())),
                }
            };
            files.push(StagedFileDto {
                source_zip: imported.source_name.clone(),
                filename: filename.clone(),
                layer_type,
                svg_body,
                bbox,
                snap,
                error,
                holes: file_holes,
            });
        }
    }
    Ok(StagedImportDto { files, holes })
}

// ---- Progressive staging: fast classify, then per-layer SVG on demand ----
//
// `stage_import` did everything (classify + parse drill + render every SVG) in
// one blocking call, so the wizard showed nothing until ALL layers were ready.
// Split it: `stage_classify` returns the layer LIST instantly (names + types +
// drill holes, no SVG), and `stage_layer_svg` renders ONE layer's SVG. The
// frontend opens the wizard immediately and fills previews in as each resolves.

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedClassFileDto {
    source_zip: String,
    filename: String,
    layer_type: cuprum_project::LayerType,
    holes: Vec<HoleDto>,
    /// Set when a drill file carried coordinate data we couldn't parse into holes
    /// (distinct from a genuinely empty drill file, which leaves this `None`).
    drill_error: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StagedClassifyDto {
    files: Vec<StagedClassFileDto>,
}

/// Classify every gerber in the ZIPs (by name) and parse drill holes — fast, no
/// SVG rendering. Order matches `stage_layer_svg`'s index and `commit_import`.
#[tauri::command]
fn stage_classify(zip_paths: Vec<String>) -> Result<StagedClassifyDto, String> {
    let mut files = Vec::new();
    for zip in &zip_paths {
        let imported =
            cuprum_project::import::read_zip_gerbers(Path::new(zip)).map_err(|e| e.to_string())?;
        for (filename, bytes) in &imported.gerbers {
            let layer_type = cuprum_project::layer::classify(filename);
            let mut holes = Vec::new();
            let mut drill_error = None;
            if matches!(layer_type, cuprum_project::LayerType::Drill) {
                match cuprum_core::drill::parse_drill(bytes) {
                    Ok(hs) => {
                        holes = hs
                            .into_iter()
                            .map(|h| HoleDto {
                                x: h.x_mm,
                                y: h.y_mm,
                                d: h.d_mm,
                            })
                            .collect()
                    }
                    Err(e) => drill_error = Some(e.to_string()),
                }
            }
            files.push(StagedClassFileDto {
                source_zip: imported.source_name.clone(),
                filename: filename.clone(),
                layer_type,
                holes,
                drill_error,
            });
        }
    }
    Ok(StagedClassifyDto { files })
}

/// Render ONE staged gerber's SVG by its staging index (the same order as
/// `stage_classify`). Called per-layer, in parallel, so previews stream in.
#[tauri::command]
fn stage_layer_svg(
    app: AppHandle,
    zip_paths: Vec<String>,
    index: usize,
) -> Result<LayerGeometryDto, String> {
    let mut i = 0usize;
    for zip in &zip_paths {
        let imported =
            cuprum_project::import::read_zip_gerbers(Path::new(zip)).map_err(|e| e.to_string())?;
        for (_filename, bytes) in &imported.gerbers {
            if i == index {
                return render_or_cache_svg(&app, bytes);
            }
            i += 1;
        }
    }
    Err(format!("staged index {index} out of range"))
}

#[tauri::command]
fn commit_import(
    app: AppHandle,
    path: String,
    zip_paths: Vec<String>,
    layer_types: Vec<cuprum_project::LayerType>,
) -> Result<cuprum_project::Manifest, String> {
    let db = catalog_db_path(&app)?;
    let zips: Vec<PathBuf> = zip_paths.into_iter().map(PathBuf::from).collect();
    cuprum_project::commit_import(&db, Path::new(&path), &zips, &layer_types, now_epoch())
        .map_err(|e| e.to_string())
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
    path: String,
    gerber_rel: String,
) -> Result<LayerGeometryDto, String> {
    let bytes = cuprum_project::container::read_entry(Path::new(&path), &gerber_rel)
        .map_err(|e| e.to_string())?;
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
    project_path: String,
    gerber_rel: String,
    holes: Vec<HoleInput>,
) -> Result<Vec<PolyDto>, String> {
    let bytes = cuprum_project::container::read_entry(Path::new(&project_path), &gerber_rel)
        .map_err(|e| e.to_string())?;
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
    project_path: String,
    gerber_rel: String,
    holes: Vec<HoleInput>,
) -> Result<Vec<PolyDto>, String> {
    layer_polygons(project_path, gerber_rel, holes)
}

/// Compute the soldermask geometry: the board region MINUS the mask openings.
/// The board outline rings are stitched on the frontend from Edge_Cuts (see
/// `boardOutline.ts`) and passed in here as absolute-mm rings (Y up).
#[tauri::command]
fn mask_polygons(
    project_path: String,
    gerber_rel: String,
    outline_rings: Vec<Vec<[f32; 2]>>,
) -> Result<Vec<PolyDto>, String> {
    let bytes = cuprum_project::container::read_entry(Path::new(&project_path), &gerber_rel)
        .map_err(|e| e.to_string())?;
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

/// Build the 3D board mesh for STAGED gerbers (the import wizard): re-read the
/// ZIPs in staging order, apply the current per-file layer types, return the
/// blob. Keys are the staging index (matches the wizard's `String(i)` keys).
#[tauri::command]
fn staged_board_mesh(
    app: AppHandle,
    zip_paths: Vec<String>,
    layer_types: Vec<cuprum_project::LayerType>,
    // Staging-index keys to OMIT from the mesh entirely (hidden drill layers): a
    // hidden drill must remove its holes from the board, not just its barrels —
    // which means re-drilling the substrate, so it's a server-side rebuild.
    excluded_keys: Vec<String>,
) -> Result<tauri::ipc::Response, String> {
    let mut entries: Vec<Vec<u8>> = Vec::new();
    for zip in &zip_paths {
        let imported =
            cuprum_project::import::read_zip_gerbers(Path::new(zip)).map_err(|e| e.to_string())?;
        for (_fname, bytes) in imported.gerbers {
            entries.push(bytes);
        }
    }
    if entries.len() != layer_types.len() {
        return Err(format!(
            "layer_types ({}) != gerbers ({})",
            layer_types.len(),
            entries.len()
        ));
    }
    let excluded: std::collections::HashSet<String> = excluded_keys.into_iter().collect();
    // Cache key: included layers only (staging-index key + type + bytes).
    let mut hasher = cuprum_core::diskcache::Hasher::new();
    hasher.add(b"mesh-v4");
    for (i, bytes) in entries.iter().enumerate() {
        if excluded.contains(&i.to_string()) {
            continue;
        }
        hasher.add(i.to_string().as_bytes());
        hasher.add(format!("{:?}", layer_types[i]).as_bytes());
        hasher.add(bytes);
    }
    let blob = board_mesh_cached(&app, &hasher.finish(), || {
        let inputs: Vec<cuprum_core::mesh::LayerInput> = entries
            .iter()
            .enumerate()
            .filter(|(i, _)| !excluded.contains(&i.to_string()))
            .map(|(i, bytes)| {
                let (role, side) = role_side(&layer_types[i]);
                cuprum_core::mesh::LayerInput {
                    key: i.to_string(),
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

/// Measure manufacturing facts (board size, layer inventory, min trace width,
/// drill statistics) for the staged gerbers under the CURRENT per-file layer-type
/// assignments. Cheap — no caching needed. The frontend judges these against its
/// capability profile to produce the DFM feasibility verdict.
#[tauri::command]
fn staged_board_metrics(
    app: AppHandle,
    zip_paths: Vec<String>,
    layer_types: Vec<cuprum_project::LayerType>,
) -> Result<cuprum_core::metrics::BoardMetrics, String> {
    let mut entries: Vec<(String, Vec<u8>)> = Vec::new();
    for zip in &zip_paths {
        let imported =
            cuprum_project::import::read_zip_gerbers(Path::new(zip)).map_err(|e| e.to_string())?;
        for (fname, bytes) in imported.gerbers {
            entries.push((fname, bytes));
        }
    }
    if entries.len() != layer_types.len() {
        return Err(format!(
            "layer_types ({}) != gerbers ({})",
            layer_types.len(),
            entries.len()
        ));
    }
    // Geometry is heavy → cache by content hash (filename + type + bytes). The
    // result is a pure measurement, so it stays valid as the user edits profile
    // thresholds (judging happens client-side).
    let mut hasher = cuprum_core::diskcache::Hasher::new();
    hasher.add(b"metrics-v12");
    for (i, (fname, bytes)) in entries.iter().enumerate() {
        hasher.add(format!("{:?}", layer_types[i]).as_bytes());
        hasher.add(fname.to_lowercase().as_bytes()); // plating is inferred from the name
        hasher.add(bytes);
    }
    let key = hasher.finish();
    if let Some(dir) = artifact_cache_dir(&app) {
        if let Some(blob) = cuprum_core::diskcache::get(&dir, &key, ARTIFACT_CACHE_TTL) {
            if let Ok(m) = serde_json::from_slice::<cuprum_core::metrics::BoardMetrics>(&blob) {
                return Ok(m);
            }
        }
    }
    let inputs: Vec<cuprum_core::metrics::MetricLayerInput> = entries
        .iter()
        .enumerate()
        .map(|(i, (fname, bytes))| {
            let lt = &layer_types[i];
            let (role, side) = role_side(lt);
            cuprum_core::metrics::MetricLayerInput {
                role,
                side,
                inner: matches!(lt, cuprum_project::LayerType::InnerCopper),
                // Excellon can't carry plating; NPTH is known only from the filename.
                plated: role == cuprum_core::mesh::Role::Drill
                    && !fname.to_lowercase().contains("npth"),
                bytes,
            }
        })
        .collect();
    let metrics = cuprum_core::metrics::board_metrics(&inputs);
    if let Some(dir) = artifact_cache_dir(&app) {
        if let Ok(blob) = serde_json::to_vec(&metrics) {
            cuprum_core::diskcache::put(
                &dir,
                &key,
                &blob,
                ARTIFACT_CACHE_MAX_BYTES,
                ARTIFACT_CACHE_TTL,
            );
        }
    }
    Ok(metrics)
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
/// container. Keys are the gerber rel path (matches the project view's keys).
#[tauri::command]
fn project_board_mesh(
    app: AppHandle,
    project_path: String,
    gerbers: Vec<GerberRef>,
    // Gerber-rel keys to OMIT (hidden drill layers); see `staged_board_mesh`.
    excluded_keys: Vec<String>,
) -> Result<tauri::ipc::Response, String> {
    let mut loaded: Vec<(String, cuprum_project::LayerType, Vec<u8>)> = Vec::new();
    for g in &gerbers {
        let bytes = cuprum_project::container::read_entry(Path::new(&project_path), &g.rel)
            .map_err(|e| e.to_string())?;
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
        .invoke_handler(tauri::generate_handler![
            discover,
            render_preview,
            compose_and_print,
            stop_print,
            list_recent_projects,
            create_project,
            open_project,
            import_zips,
            remove_recent,
            update_project_metadata,
            stage_import,
            stage_classify,
            stage_layer_svg,
            commit_import,
            render_gerber_svg,
            copper_polygons,
            layer_polygons,
            mask_polygons,
            staged_board_mesh,
            staged_board_metrics,
            project_board_mesh,
            read_drill,
            display_px_per_mm
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cuprum");
}
