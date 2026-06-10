use crate::commands::error::CmdResult;
use std::time::Duration;

use tauri::{AppHandle, Manager};

use crate::commands::project::read_workdir_file;
use crate::traces_dir;

// ---- Artifact disk cache (content-addressed): rendered SVG + 3D mesh ----
//
// Heavy derived artifacts are cached on disk, keyed by a hash of the source
// gerber bytes (+ params), so re-imports / reopens / type toggles are instant.
// Defaults live here as one block — TODO: expose in app settings.
pub(crate) const ARTIFACT_CACHE_MAX_BYTES: u64 = 256 * 1024 * 1024; // 256 MB
pub(crate) const ARTIFACT_CACHE_TTL: Duration = Duration::from_secs(7 * 24 * 60 * 60); // 7 days

/// The artifact cache directory under the OS app-cache dir, or None if it can't
/// be resolved (then caching is simply skipped).
pub(crate) fn artifact_cache_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_cache_dir().ok().map(|d| d.join("artifacts"))
}

// ---- 3D board mesh (triangulated in Rust, returned as a binary blob) ----
//
// The whole 3D geometry pipeline runs here, off the UI thread, and ships ONE
// binary buffer (positions/normals/indices, per-layer Z baked in). The frontend
// just uploads typed-array views — no booleans, triangulation, SVG parsing, or
// per-hole meshes on the main thread, and no multi-megabyte `JSON.parse`.

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
pub(crate) fn pack_board_mesh(board: cuprum_core::mesh::BoardMesh) -> Vec<u8> {
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
pub(crate) fn board_mesh_cached(
    app: &AppHandle,
    key: &str,
    build: impl FnOnce() -> Vec<u8>,
) -> Vec<u8> {
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
pub(crate) struct GerberRef {
    pub rel: String,
    pub layer_type: cuprum_project::LayerType,
}

/// Build the 3D board mesh for a COMMITTED project: read each gerber from the
/// working dir. Keys are the gerber rel path (matches the project view's keys).
#[tauri::command]
pub(crate) async fn project_board_mesh(
    app: AppHandle,
    working_dir: String,
    gerbers: Vec<GerberRef>,
    // Gerber-rel keys to OMIT from the mesh entirely (hidden drill layers): a
    // hidden drill must remove its holes from the board, not just its barrels —
    // which means re-drilling the substrate, so it's a server-side rebuild.
    excluded_keys: Vec<String>,
    // FR4 substrate thickness in mm (from the panel stackup; the frontend falls
    // back to the default when the panel is not configured). Bakes the board Z,
    // so it's part of the cache key.
    thickness_mm: f32,
) -> CmdResult<tauri::ipc::Response> {
    // Async + spawn_blocking: disk read + geometry is CPU-bound; keep it off the
    // main thread so concurrent calls (one per design card) don't serialize.
    let blob = tauri::async_runtime::spawn_blocking(move || -> CmdResult<Vec<u8>> {
        let mut loaded: Vec<(String, cuprum_project::LayerType, Vec<u8>)> = Vec::new();
        for g in &gerbers {
            let bytes = read_workdir_file(&working_dir, &g.rel)?;
            loaded.push((g.rel.clone(), g.layer_type, bytes));
        }
        let excluded: std::collections::HashSet<String> = excluded_keys.into_iter().collect();
        // Cache key: included layers only (rel-path key + type + bytes) + thickness.
        let mut hasher = cuprum_core::diskcache::Hasher::new();
        hasher.add(cuprum_core::artifact::MESH_VERSION);
        hasher.add(&thickness_mm.to_le_bytes());
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
                    let (role, side) = cuprum_project::layer::role_side(*t);
                    cuprum_core::mesh::LayerInput {
                        key: rel.clone(),
                        role,
                        side,
                        bytes,
                    }
                })
                .collect();
            cuprum_core::trace::operation("mesh", &traces_dir(&app), || {
                pack_board_mesh(cuprum_core::mesh::board_geometry(&inputs, thickness_mm))
            })
        });
        Ok(blob)
    })
    .await??;
    // Response is not Send; build it after the blocking task completes.
    Ok(tauri::ipc::Response::new(blob))
}

/// Wraps `BoardMetrics` with a `fresh` flag so the frontend can trigger a repack
/// only when the artifact was newly computed (not served from disk cache).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BoardMetricsDto {
    metrics: cuprum_core::dfm::BoardMetrics,
    /// True when the artifact blob did not exist on disk before this call.
    fresh: bool,
}

/// Measure manufacturing facts (DFM) for a COMMITTED design: read each gerber
/// from the working dir under its current layer-type assignment. Cached by
/// content hash (filename + type + bytes) — a pure measurement, so it stays valid
/// as the user edits capability thresholds (judging is client-side).
#[tauri::command]
pub(crate) async fn project_board_metrics(
    app: AppHandle,
    working_dir: String,
    gerbers: Vec<GerberRef>,
    trace_session: Option<u64>,
) -> CmdResult<BoardMetricsDto> {
    // Async + spawn_blocking: disk read + geometry is CPU-bound; keep it off the
    // main thread so concurrent calls (one per design card) don't serialize.
    tauri::async_runtime::spawn_blocking(move || -> CmdResult<BoardMetricsDto> {
        let mut loaded: Vec<(String, cuprum_project::LayerType, Vec<u8>)> = Vec::new();
        for g in &gerbers {
            let bytes = read_workdir_file(&working_dir, &g.rel)?;
            loaded.push((g.rel.clone(), g.layer_type, bytes));
        }
        // Key built in core so `artifact::gc` can reconstruct the same set.
        // Precompute small type strings once; pass borrowed byte slices to avoid
        // cloning multi-MB gerber buffers on the hot path.
        let type_strs: Vec<String> = loaded.iter().map(|(_, t, _)| format!("{t:?}")).collect();
        let key = cuprum_core::cache::metrics_artifact_key(
            loaded
                .iter()
                .zip(&type_strs)
                .map(|((rel, _, bytes), ts)| (rel.as_str(), ts.as_str(), bytes.as_slice())),
        );
        // Build metric inputs from the loaded layers. Done inside the render
        // closure (see below) so a cache hit skips this entirely; the result
        // borrows `loaded`'s bytes, hence `loaded` is moved into the closure.
        // A nested `fn` (not a closure) so the input/output lifetime is tied.
        fn build_inputs(
            loaded: &[(String, cuprum_project::LayerType, Vec<u8>)],
        ) -> Vec<cuprum_core::dfm::MetricLayerInput<'_>> {
            loaded
                .iter()
                .map(|(rel, t, bytes)| {
                    let (role, side) = cuprum_project::layer::role_side(*t);
                    cuprum_core::dfm::MetricLayerInput {
                        role,
                        side,
                        inner: matches!(t, cuprum_project::LayerType::InnerCopper),
                        // Excellon can't carry plating; NPTH is known only from the filename.
                        plated: role == cuprum_core::mesh::Role::Drill
                            && !rel.to_lowercase().contains("npth"),
                        bytes,
                    }
                })
                .collect()
        }
        let dir = std::path::Path::new(&working_dir)
            .join("artifacts")
            .join("metrics");
        use crate::commands::render::artifact_fresh;
        let fresh = artifact_fresh(&dir, &key);
        let traces = traces_dir(&app);
        let metrics = cuprum_core::cache::board_metrics_artifact(&dir, &key, move || {
            let inputs = build_inputs(&loaded);
            cuprum_core::trace::operation_in_session(trace_session, "metrics", &traces, || {
                cuprum_core::dfm::board_metrics(&inputs)
            })
        });
        Ok(BoardMetricsDto { metrics, fresh })
    })
    .await?
}
