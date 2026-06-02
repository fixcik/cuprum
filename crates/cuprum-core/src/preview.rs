//! Backend composite preview: assemble the colored layer stack (the same picture
//! the frontend `LayerStack` builds) into one standalone SVG document, then
//! rasterize to a PNG thumbnail with resvg. Used for design-card thumbnails so a
//! card mounts one `<img>` instead of a heavy multi-layer SVG DOM, and the PNG
//! ships inside the `.cuprum` (persistent artifact). Mirrors `layerColors.ts`.

/// Default per-type colors — keep in sync with `DEFAULT_LAYER_COLORS`
/// (layerColors.ts). Keyed by the IPC `layer_type` camelCase string.
#[allow(dead_code)] // used by the next task (compose/rasterize)
fn default_color(layer_type: &str) -> &'static str {
    match layer_type {
        "topCopper" | "bottomCopper" | "innerCopper" => "#caa84a",
        "topMask" | "bottomMask" => "#257d55",
        "topSilk" | "bottomSilk" => "#f0f0f0",
        "topPaste" | "bottomPaste" => "#c3c7cc",
        "edgeCuts" => "#59512c",
        "drill" => "#2a2a2a",
        _ => "#8a8f98", // "other" / unknown
    }
}

/// Painter's order — keep in sync with `LAYER_Z` (layerColors.ts). Lower draws
/// first (underneath). edgeCuts sits under everything.
#[allow(dead_code)] // used by the next task (compose/rasterize)
fn z_order(layer_type: &str) -> i32 {
    match layer_type {
        "edgeCuts" => -1,
        "bottomCopper" => 1,
        "bottomMask" => 2,
        "bottomSilk" => 3,
        "bottomPaste" => 4,
        "innerCopper" => 5,
        "topCopper" => 6,
        "topMask" => 7,
        "topSilk" => 8,
        "topPaste" => 9,
        "drill" => 10,
        _ => 0, // "other"
    }
}

/// Resolve a layer's color: per-call override wins over the default palette.
#[allow(dead_code)] // used by the next task (compose/rasterize)
fn resolve_color(
    layer_type: &str,
    overrides: &std::collections::HashMap<String, String>,
) -> String {
    overrides
        .get(layer_type)
        .cloned()
        .unwrap_or_else(|| default_color(layer_type).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palette_and_order_match_frontend() {
        assert_eq!(default_color("topCopper"), "#caa84a");
        assert_eq!(default_color("edgeCuts"), "#59512c");
        assert_eq!(default_color("nonsense"), "#8a8f98");
        assert!(z_order("edgeCuts") < z_order("bottomCopper"));
        assert!(z_order("topSilk") > z_order("topCopper"));
    }

    #[test]
    fn override_wins_over_default() {
        let mut o = std::collections::HashMap::new();
        o.insert("topCopper".to_string(), "#ff0000".to_string());
        assert_eq!(resolve_color("topCopper", &o), "#ff0000");
        assert_eq!(resolve_color("edgeCuts", &o), "#59512c");
    }
}
