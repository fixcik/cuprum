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

/// Bump when `svg::render_layer_svg` output changes.
pub const SVG_VERSION: &[u8] = b"svg-v1";

/// Bump when `metrics::board_metrics` output changes (was hard-coded in main.rs).
pub const METRICS_VERSION: &[u8] = b"metrics-v14";

/// Bump when the preview composition/palette/size changes.
pub const PREVIEW_VERSION: &[u8] = b"preview-v1";

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
        for v in [SVG_VERSION, METRICS_VERSION, PREVIEW_VERSION] {
            assert!(!v.is_empty(), "version tag must be non-empty");
        }
        assert_ne!(SVG_VERSION, METRICS_VERSION);
        assert_ne!(SVG_VERSION, PREVIEW_VERSION);
        assert_ne!(METRICS_VERSION, PREVIEW_VERSION);
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
