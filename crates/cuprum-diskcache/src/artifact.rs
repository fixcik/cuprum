//! Single source of truth for derived-artifact versioning and orphan cleanup.
//!
//! Every persistent artifact (rendered SVG, DFM metrics, preview PNG) is stored
//! content-addressed: its filename is a hash of the SOURCE bytes plus a version
//! tag from this module. Bumping a tag changes every key for that artifact kind,
//! so a process change auto-invalidates on the read path (a miss → regenerate)
//! and the stale files are swept on the write path (`gc` at pack time).
//!
//! Rule: when you change how an artifact is produced (SVG render, metrics
//! algorithm, preview composition), bump the matching `*_VERSION` here. That is
//! the ONLY place a version lives — keep it out of `main.rs` and the manifest.
//!
//! `MESH_VERSION` also lives here for the same single-source-of-truth reason, but
//! the 3D mesh is NOT a persistent project artifact: it is cached in the global OS
//! app-cache (TTL + LRU), never packed into the `.cuprum`, so it is intentionally
//! absent from the `gc` sweep below.

/// Bump when `svg::render_layer_svg` output changes.
/// v2: connected line segments coalesced into one polyline path.
/// v3: G74 single-quadrant arc center selection + polygon winding fixed.
pub const SVG_VERSION: &[u8] = b"svg-v3";

/// Bump when `dfm::board_metrics` output changes (was hard-coded in main.rs).
/// v15: annular hotspots now carry the pad's copper side instead of hardcoded "both".
/// v16: trace/line strokes coalesced into round-joined polylines.
/// v17: per-family hotspot cap raised 40→500; drill/via unified onto cell dedup.
/// v18: BoardDims gains origin_x_mm/origin_y_mm (Edge_Cuts outline min corner).
/// v19: annular ring takes the worst pad across copper layers; geometry fixes
/// (G74 arcs, winding, macro unary minus).
/// v20: CIRCLE_SEGS 32→64 (rounder drilled-hole circles) shifts drill geometry.
pub const METRICS_VERSION: &[u8] = b"metrics-v20";

/// Bump when the preview composition/palette/size changes.
/// v2: FR4 substrate + inverted soldermask + top-side-only composition.
/// v3: substrate/mask/layers clipped to the rounded Edge_Cuts outline.
/// v4: composite framed to the board-outline bbox (was union-of-layers bbox).
/// v5: G74 single-quadrant arc center selection + polygon winding fixed.
/// v6: indexed PNG-8 output (was truecolor PNG); key now carries PreviewSizing.
/// v7: drill holes punched transparent through the composite (drill now part of key).
/// v8: drill holes punched via a luminance mask instead of an evenodd clip (resvg).
pub const PREVIEW_VERSION: &[u8] = b"preview-v8";

/// Bump when `mesh::board_geometry` output changes (triangulation, layer/barrel
/// emission, substrate Z). Unlike the others this keys the OS app-cache mesh blob,
/// not a packed `.cuprum` artifact (see module docs) — bumping just orphans the
/// old cache entry, which the TTL/LRU reclaims.
pub const MESH_VERSION: &[u8] = b"mesh-v10";

use std::collections::HashSet;
use std::path::Path;

/// Sweep orphaned artifact blobs under `artifacts_dir/{svg,metrics,preview}`:
/// delete every `<key>.bin` whose `<key>` is NOT in `valid_keys`. Persistent
/// artifacts never self-expire, so this is how stale entries (after a version
/// bump, recolor, or design removal) leave the project at pack time. Best-effort:
/// IO errors are ignored. Non-`.bin` files are left untouched.
pub fn gc(artifacts_dir: &Path, valid_keys: &HashSet<String>) {
    for kind in ["svg", "metrics", "preview"] {
        let sub = artifacts_dir.join(kind);
        let Ok(rd) = std::fs::read_dir(&sub) else {
            continue;
        };
        for ent in rd.flatten() {
            let path = ent.path();
            if path.extension().and_then(|s| s.to_str()) != Some("bin") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if !valid_keys.contains(stem) {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_are_distinct_nonempty() {
        let all = [SVG_VERSION, METRICS_VERSION, PREVIEW_VERSION, MESH_VERSION];
        for v in all {
            assert!(!v.is_empty(), "version tag must be non-empty");
        }
        // Every pair must be distinct so tags never collide across artifact kinds.
        for (i, a) in all.iter().enumerate() {
            for b in &all[i + 1..] {
                assert_ne!(a, b, "version tags must be distinct");
            }
        }
    }

    #[test]
    fn gc_keeps_valid_drops_orphans() {
        let dir = std::env::temp_dir().join(format!("cuprum-gc-{}", std::process::id()));
        let sub = dir.join("svg");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("keepkey.bin"), b"valid").unwrap();
        std::fs::write(sub.join("orphankey.bin"), b"stale").unwrap();
        // A non-.bin file must be left untouched.
        std::fs::write(sub.join("notes.txt"), b"x").unwrap();

        let mut valid = HashSet::new();
        valid.insert("keepkey".to_string());
        gc(&dir, &valid);

        assert!(sub.join("keepkey.bin").exists(), "valid key kept");
        assert!(!sub.join("orphankey.bin").exists(), "orphan key dropped");
        assert!(sub.join("notes.txt").exists(), "non-.bin left alone");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
