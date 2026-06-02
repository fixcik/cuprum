//! Backend composite preview: assemble the colored layer stack (the same picture
//! the frontend `LayerStack` builds) into one standalone SVG document, then
//! rasterize to a PNG thumbnail with resvg. Used for design-card thumbnails so a
//! card mounts one `<img>` instead of a heavy multi-layer SVG DOM, and the PNG
//! ships inside the `.cuprum` (persistent artifact). Mirrors `layerColors.ts`.

use crate::svg::{BBox, LayerGeometry};
use std::collections::HashMap;
use std::fmt::Write as _;

/// Default per-type colors — keep in sync with `DEFAULT_LAYER_COLORS`
/// (layerColors.ts). Keyed by the IPC `layer_type` camelCase string.
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
fn resolve_color(
    layer_type: &str,
    overrides: &std::collections::HashMap<String, String>,
) -> String {
    overrides
        .get(layer_type)
        .cloned()
        .unwrap_or_else(|| default_color(layer_type).to_string())
}

/// Union of all layer bboxes (mm, Y up). `None` if empty.
fn union_bbox(layers: &[(String, LayerGeometry)]) -> Option<BBox> {
    layers.iter().map(|(_, g)| g.bbox).reduce(|a, b| BBox {
        min_x: a.min_x.min(b.min_x),
        min_y: a.min_y.min(b.min_y),
        max_x: a.max_x.max(b.max_x),
        max_y: a.max_y.max(b.max_y),
    })
}

/// Assemble a self-contained colored SVG document from per-layer fragments.
/// Layers are drawn in `z_order` (lower first / underneath). Coordinates are mm;
/// the root flips Y (gerber Y-up → SVG Y-down) via a translate+scale transform so
/// the fragments' absolute-mm geometry renders upright.
pub fn compose_svg(
    layers: &[(String, LayerGeometry)],
    overrides: &HashMap<String, String>,
) -> String {
    let Some(bb) = union_bbox(layers) else {
        return r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>"#.to_string();
    };
    let w = (bb.max_x - bb.min_x).max(f32::MIN_POSITIVE);
    let h = (bb.max_y - bb.min_y).max(f32::MIN_POSITIVE);

    // Draw order: indices sorted by z (stable for ties).
    let mut idx: Vec<usize> = (0..layers.len()).collect();
    idx.sort_by_key(|&i| z_order(&layers[i].0));

    let mut out = String::new();
    let _ = write!(
        out,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="{minx} {miny} {w} {h}">"#,
        minx = trim(bb.min_x),
        miny = trim(bb.min_y),
        w = trim(w),
        h = trim(h),
    );
    // Flip Y about the bbox: translate to top, scale Y by -1. Done as a group
    // transform so fragment coordinates stay in absolute mm.
    let _ = write!(
        out,
        r#"<g transform="translate(0,{ty}) scale(1,-1)">"#,
        ty = trim(bb.min_y + bb.max_y),
    );
    for &i in &idx {
        let (lt, g) = &layers[i];
        let color = resolve_color(lt, overrides);
        let _ = write!(
            out,
            r#"<g fill="{c}" stroke="{c}" color="{c}">{body}</g>"#,
            c = color,
            body = g.svg_body,
        );
    }
    out.push_str("</g></svg>");
    out
}

/// Format an f32 coordinate without trailing zeros (compact, locale-free).
fn trim(v: f32) -> String {
    let s = format!("{v:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    if s.is_empty() || s == "-0" {
        "0".to_string()
    } else {
        s.to_string()
    }
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

    use crate::svg::{BBox, LayerGeometry};

    fn geom(body: &str, min_x: f32, min_y: f32, max_x: f32, max_y: f32) -> LayerGeometry {
        LayerGeometry {
            svg_body: body.to_string(),
            bbox: BBox {
                min_x,
                min_y,
                max_x,
                max_y,
            },
            snap: vec![],
        }
    }

    #[test]
    fn compose_orders_layers_and_sets_viewbox() {
        // copper (z=6) given before edgeCuts (z=-1); compose must draw edgeCuts first.
        let layers = vec![
            (
                "topCopper".to_string(),
                geom("<circle/>", 0.0, 0.0, 10.0, 8.0),
            ),
            ("edgeCuts".to_string(), geom("<rect/>", 0.0, 0.0, 10.0, 8.0)),
        ];
        let overrides = std::collections::HashMap::new();
        let doc = compose_svg(&layers, &overrides);
        assert!(doc.starts_with("<svg"), "standalone svg root");
        assert!(
            doc.contains("viewBox=\"0 0 10 8\""),
            "viewBox from union bbox: got {doc}"
        );
        let edge = doc.find("<rect/>").expect("edge body present");
        let cu = doc.find("<circle/>").expect("copper body present");
        assert!(edge < cu, "edgeCuts drawn before copper (under it)");
        assert!(doc.contains("#59512c"), "edge color applied");
        assert!(doc.contains("#caa84a"), "copper color applied");
        assert!(
            doc.contains("scale(1,-1)") || doc.contains("matrix"),
            "Y flip present"
        );
    }
}
