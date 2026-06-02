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
}
