use crate::commands::error::CmdResult;
use base64::Engine;
use tauri::AppHandle;

use crate::commands::board::GerberRef;
use crate::commands::project::read_workdir_file;
use crate::traces_dir;

// ---- Working-dir gerber inspection (drill holes, SVG geometry) ----

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreviewDto {
    pub png_data_url: String,
    /// True when the artifact blob did not exist on disk before this call.
    pub fresh: bool,
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HoleDto {
    pub x: f32,
    pub y: f32,
    pub d: f32,
}

#[tauri::command]
pub(crate) fn read_drill(working_dir: String, gerber_rel: String) -> CmdResult<Vec<HoleDto>> {
    let bytes = read_workdir_file(&working_dir, &gerber_rel)?;
    let holes = cuprum_core::drill::parse_drill(&bytes)?;
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
pub(crate) struct BBoxDto {
    pub min_x: f32,
    pub min_y: f32,
    pub max_x: f32,
    pub max_y: f32,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LayerGeometryDto {
    pub svg_body: String,
    pub bbox: BBoxDto,
    pub snap: Vec<[f32; 2]>,
}

/// Per-layer batch render result, in input order. Exactly one of `geometry` /
/// `error` is set: success carries geometry, a broken/missing gerber carries an
/// error string — one bad layer never sinks the batch. `fresh` is true when the
/// artifact blob did not exist on disk before this call.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LayerSvgResult {
    pub rel: String,
    pub geometry: Option<LayerGeometryDto>,
    pub error: Option<String>,
    pub fresh: bool,
}

#[tauri::command]
pub(crate) fn render_gerber_svg(
    app: AppHandle,
    working_dir: String,
    gerber_rel: String,
) -> CmdResult<LayerGeometryDto> {
    let bytes = read_workdir_file(&working_dir, &gerber_rel)?;
    cuprum_core::trace::operation("svg", &traces_dir(&app), || {
        render_svg_dto(&working_dir, &bytes).map(|(dto, _)| dto)
    })
}

/// Render many gerbers' SVG in one IPC round-trip. Async + spawn_blocking
/// (CPU-bound) and rayon `par_iter` so layers render in parallel; results are
/// returned in input order, per-layer tolerant (one bad gerber doesn't fail the
/// batch). Each layer goes through core's in-memory + disk cache.
/// All layers share ONE trace file (`svg_batch`) with per-thread tracks.
#[tauri::command]
pub(crate) async fn render_layers_svg(
    app: AppHandle,
    working_dir: String,
    rels: Vec<String>,
    trace_session: Option<u64>,
) -> CmdResult<Vec<LayerSvgResult>> {
    let traces = traces_dir(&app);
    tauri::async_runtime::spawn_blocking(move || {
        cuprum_core::trace::operation_in_session(trace_session, "svg_batch", &traces, || {
            use rayon::prelude::*;
            // Capture dispatch + parent span on the outer thread so worker
            // threads can record into the same trace file.
            let dh = cuprum_core::trace::capture_dispatch();
            rels.par_iter()
                .map(|rel| {
                    dh.run(|| {
                        let res = read_workdir_file(&working_dir, rel)
                            .and_then(|bytes| render_svg_dto(&working_dir, &bytes));
                        match res {
                            Ok((geometry, fresh)) => LayerSvgResult {
                                rel: rel.clone(),
                                geometry: Some(geometry),
                                error: None,
                                fresh,
                            },
                            Err(e) => LayerSvgResult {
                                rel: rel.clone(),
                                geometry: None,
                                error: Some(e.message().to_string()),
                                fresh: false,
                            },
                        }
                    })
                })
                .collect::<Vec<_>>()
        })
    })
    .await
    .map_err(|e| format!("batch svg join error: {e}").into())
}

// ---- Copper polygons (2D boolean booleans in Rust core) ----

#[derive(serde::Deserialize)]
pub(crate) struct HoleInput {
    pub x: f64,
    pub y: f64,
    pub d: f64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PolyDto {
    pub outer: Vec<[f32; 2]>,
    pub holes: Vec<Vec<[f32; 2]>>,
}

pub(crate) fn polys_to_dtos(polys: Vec<cuprum_core::geometry::Poly>) -> Vec<PolyDto> {
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
pub(crate) fn layer_polygons(
    working_dir: String,
    gerber_rel: String,
    holes: Vec<HoleInput>,
) -> CmdResult<Vec<PolyDto>> {
    let bytes = read_workdir_file(&working_dir, &gerber_rel)?;
    let holes: Vec<cuprum_core::geometry::Hole> = holes
        .into_iter()
        .map(|h| cuprum_core::geometry::Hole {
            x: h.x,
            y: h.y,
            d: h.d,
        })
        .collect();
    let polys = cuprum_core::geometry::layer_polygons(&bytes, &holes)?;
    Ok(polys_to_dtos(polys))
}

/// Backwards-compatible alias kept so the original copper wiring keeps working.
#[tauri::command]
pub(crate) fn copper_polygons(
    working_dir: String,
    gerber_rel: String,
    holes: Vec<HoleInput>,
) -> CmdResult<Vec<PolyDto>> {
    layer_polygons(working_dir, gerber_rel, holes)
}

/// Compute the soldermask geometry: the board region MINUS the mask openings.
/// The board outline rings are stitched on the frontend from Edge_Cuts (see
/// `boardOutline.ts`) and passed in here as absolute-mm rings (Y up).
#[tauri::command]
pub(crate) fn mask_polygons(
    working_dir: String,
    gerber_rel: String,
    outline_rings: Vec<Vec<[f32; 2]>>,
) -> CmdResult<Vec<PolyDto>> {
    let bytes = read_workdir_file(&working_dir, &gerber_rel)?;
    let rings: Vec<Vec<[f64; 2]>> = outline_rings
        .into_iter()
        .map(|ring| {
            ring.into_iter()
                .map(|[x, y]| [x as f64, y as f64])
                .collect()
        })
        .collect();
    let polys = cuprum_core::geometry::mask_polygons(&rings, &bytes)?;
    Ok(polys_to_dtos(polys))
}

/// Returns `true` when the artifact blob (`<kind_dir>/<key>.bin`) does NOT yet
/// exist on disk — i.e. the next cache call will produce a new artifact. Lets
/// callers decide whether a `.cuprum` repack is warranted.
pub(crate) fn artifact_fresh(kind_dir: &std::path::Path, key: &str) -> bool {
    !kind_dir.join(format!("{key}.bin")).exists()
}

/// Render one gerber's SVG into the PROJECT artifact cache
/// (`<workdir>/artifacts/svg`), going through core's in-memory + persistent disk
/// cache. The blob ships inside the `.cuprum` (packed by `workdir::pack`) so a
/// transferred project never re-renders. Tracing is the caller's responsibility.
/// Returns `(dto, fresh)` where `fresh` indicates the artifact was not cached on disk.
pub(crate) fn render_svg_dto(
    working_dir: &str,
    bytes: &[u8],
) -> CmdResult<(LayerGeometryDto, bool)> {
    let dir = std::path::Path::new(working_dir)
        .join("artifacts")
        .join("svg");
    let key = cuprum_core::cache::svg_artifact_key(bytes);
    let fresh = artifact_fresh(&dir, &key);
    let g = cuprum_core::cache::layer_svg_artifact(&dir, bytes)?;
    Ok((
        LayerGeometryDto {
            svg_body: g.svg_body,
            bbox: BBoxDto {
                min_x: g.bbox.min_x,
                min_y: g.bbox.min_y,
                max_x: g.bbox.max_x,
                max_y: g.bbox.max_y,
            },
            snap: g.snap,
        },
        fresh,
    ))
}

/// Preview variant: fixed-size thumbnail for the card grid, or density-based
/// detail image for the panel editor canvas.
#[derive(serde::Deserialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PreviewVariant {
    /// Fixed 512px thumbnail, persisted in the `.cuprum` (card grid).
    #[default]
    Card,
    /// Density-sized (12 px/mm) detail for the panel editor; transient app-cache.
    Detailed,
}

/// Return a cached detailed-preview blob for `key` from the OS app-cache, or build
/// it via `build`, cache it (TTL/LRU), and return. Best-effort (skipped if the
/// cache dir is unavailable). Mirrors `board_mesh_cached`.
fn design_preview_cached(
    app: &AppHandle,
    key: &str,
    build: impl FnOnce() -> anyhow::Result<Vec<u8>>,
) -> anyhow::Result<(Vec<u8>, bool)> {
    use crate::commands::board::{artifact_cache_dir, ARTIFACT_CACHE_MAX_BYTES, ARTIFACT_CACHE_TTL};
    let dir = artifact_cache_dir(app);
    if let Some(d) = &dir {
        if let Some(blob) = cuprum_core::diskcache::get(d, key, ARTIFACT_CACHE_TTL) {
            return Ok((blob, false));
        }
    }
    let blob = build()?;
    if let Some(d) = &dir {
        cuprum_core::diskcache::put(d, key, &blob, ARTIFACT_CACHE_MAX_BYTES, ARTIFACT_CACHE_TTL);
    }
    Ok((blob, true))
}

/// Render a design's composite preview PNG into the project artifact cache
/// (`<workdir>/artifacts/preview`) and return it as a data URL for a card `<img>`.
/// Non-drill layers only (no holes), top side — matches the card's old LayerStack
/// thumbnail. Persistent + content-keyed, so it ships in the `.cuprum` and only
/// recomputes when gerbers or colors change.
///
/// Pass `variant: "detailed"` to get a density-sized (12 px/mm) image cached
/// transiently in the OS app-cache, suitable for the panel editor canvas.
#[tauri::command]
pub(crate) async fn render_design_preview(
    app: AppHandle,
    working_dir: String,
    design_id: String,
    gerbers: Vec<GerberRef>,
    layer_colors: Option<std::collections::HashMap<String, String>>,
    variant: Option<PreviewVariant>,
    trace_session: Option<u64>,
) -> CmdResult<PreviewDto> {
    let _ = &design_id; // label/trace only
    let variant = variant.unwrap_or_default();
    let overrides = layer_colors.unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<PreviewDto> {
        let mut layers: Vec<cuprum_core::preview::PreviewLayer> = Vec::new();
        for g in &gerbers {
            // IPC camelCase string (e.g. "topCopper"/"drill") — MUST match the
            // pack-gc key reconstruction in cuprum-project (serde repr, not Debug).
            let lt = serde_json::to_value(g.layer_type)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_else(|| "other".to_string());
            if lt == "drill" {
                continue;
            }
            let bytes = read_workdir_file(&working_dir, &g.rel)?;
            layers.push(cuprum_core::preview::PreviewLayer {
                layer_type: lt,
                bytes,
            });
        }
        let dir = std::path::Path::new(&working_dir).join("artifacts");
        let sizing = match variant {
            PreviewVariant::Card => cuprum_core::preview::PreviewSizing::MaxPx(
                cuprum_core::preview::CARD_PREVIEW_MAX_PX,
            ),
            PreviewVariant::Detailed => cuprum_core::preview::PreviewSizing::Density {
                px_per_mm: cuprum_core::preview::DETAILED_PREVIEW_PX_PER_MM,
                cap_px: cuprum_core::preview::DETAILED_PREVIEW_MAX_PX,
            },
        };
        let key = cuprum_core::preview::preview_key(&layers, &overrides, sizing);
        let traces = traces_dir(&app);
        let (png, fresh) = match variant {
            PreviewVariant::Card => {
                let fresh = artifact_fresh(&dir.join("preview"), &key);
                let png = cuprum_core::trace::operation_in_session(
                    trace_session,
                    "preview",
                    &traces,
                    || {
                        cuprum_core::preview::render_design_preview(
                            &dir, &layers, &overrides, sizing,
                        )
                    },
                )?;
                (png, fresh)
            }
            PreviewVariant::Detailed => design_preview_cached(&app, &key, || {
                cuprum_core::trace::operation_in_session(
                    trace_session,
                    "preview_detailed",
                    &traces,
                    || {
                        cuprum_core::preview::render_preview_png(&dir, &layers, &overrides, sizing)
                    },
                )
            })?,
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
        Ok(PreviewDto {
            png_data_url: format!("data:image/png;base64,{b64}"),
            fresh,
        })
    })
    .await
    .map_err(|e| format!("preview join error: {e}"))?
}
