//! Backend composite preview: assemble the colored layer stack (the same picture
//! the frontend `LayerStack` builds) into one standalone SVG document, then
//! rasterize to a PNG thumbnail with resvg. Used for design-card thumbnails so a
//! card mounts one `<img>` instead of a heavy multi-layer SVG DOM, and the PNG
//! ships inside the `.cuprum` (persistent artifact). Mirrors `layerColors.ts`.

use crate::svg::{BBox, LayerGeometry};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::path::Path;

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

/// One layer feeding the composite: raw gerber bytes + its IPC layer-type string.
#[derive(Clone)]
pub struct PreviewLayer {
    pub layer_type: String,
    pub bytes: Vec<u8>,
}

/// Content-hash key for a design's preview: version + each layer's
/// (type, color, gerber-content), sorted by layer_type so input order doesn't
/// change the key. Shared with `artifact::gc`'s valid set.
pub fn preview_key(layers: &[PreviewLayer], overrides: &HashMap<String, String>) -> String {
    let mut h = crate::diskcache::Hasher::new();
    h.add(crate::artifact::PREVIEW_VERSION);
    let mut sorted: Vec<&PreviewLayer> = layers.iter().collect();
    sorted.sort_by(|a, b| a.layer_type.cmp(&b.layer_type));
    for l in sorted {
        h.add(l.layer_type.as_bytes());
        h.add(resolve_color(&l.layer_type, overrides).as_bytes());
        h.add(&l.bytes);
    }
    h.finish()
}

/// Render a design's composite preview to a PNG (longest side == `max_px`),
/// caching it persistently under `<artifacts_dir>/preview/<key>.bin`. On a cache
/// hit returns the stored bytes. Drill layers should be excluded by the caller
/// (the card preview has no holes); composes top side only. Honors `cache_disabled()`.
pub fn render_design_preview(
    artifacts_dir: &Path,
    layers: &[PreviewLayer],
    overrides: &HashMap<String, String>,
    max_px: u32,
) -> anyhow::Result<Vec<u8>> {
    let key = preview_key(layers, overrides);
    let dir = artifacts_dir.join("preview");
    if !crate::diskcache::cache_disabled() {
        if let Some(png) = crate::diskcache::get_persistent(&dir, &key) {
            return Ok(png);
        }
    }
    // Render each layer's SVG fragment from the raw gerber bytes.
    let mut composed: Vec<(String, LayerGeometry)> = Vec::with_capacity(layers.len());
    for l in layers {
        let id = format!("pv{}", &crate::diskcache::key_for(&[&l.bytes])[..8]);
        let g = crate::svg::render_layer_svg(&l.bytes, &id)?;
        composed.push((l.layer_type.clone(), g));
    }
    let doc = compose_svg(&composed, overrides);
    let png = rasterize(&doc, max_px)?;
    if !crate::diskcache::cache_disabled() {
        crate::diskcache::put_persistent(&dir, &key, &png);
    }
    Ok(png)
}

/// Rasterize a standalone SVG document to PNG with resvg, scaled so the longest
/// side equals `max_px`.
fn rasterize(svg: &str, max_px: u32) -> anyhow::Result<Vec<u8>> {
    let opt = usvg::Options::default();
    let tree = usvg::Tree::from_str(svg, &opt).map_err(|e| anyhow::anyhow!("usvg parse: {e}"))?;
    let size = tree.size();
    let longest = size.width().max(size.height()).max(1.0);
    let scale = (max_px as f32) / longest;
    let pw = (size.width() * scale).ceil().max(1.0) as u32;
    let ph = (size.height() * scale).ceil().max(1.0) as u32;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(pw, ph)
        .ok_or_else(|| anyhow::anyhow!("pixmap alloc {pw}x{ph}"))?;
    let transform = resvg::tiny_skia::Transform::from_scale(scale, scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    let png = pixmap
        .encode_png()
        .map_err(|e| anyhow::anyhow!("encode_png: {e}"))?;
    Ok(png)
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

    // A 1mm circle flashed at the origin — drawable geometry for a real raster.
    const GBR: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.0*%\nD10*\nX0Y0D03*\nM02*\n";

    #[test]
    fn render_design_preview_makes_a_sized_png_and_persists() {
        let dir = std::env::temp_dir().join(format!("cuprum-preview-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let layers = vec![PreviewLayer {
            layer_type: "topCopper".to_string(),
            bytes: GBR.to_vec(),
        }];
        let overrides = std::collections::HashMap::new();

        let png = render_design_preview(&dir, &layers, &overrides, 128).expect("preview ok");
        assert_eq!(
            &png[..8],
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
            "png header"
        );
        assert!(png.len() > 100, "non-empty png");

        let sub = dir.join("preview");
        let n = std::fs::read_dir(&sub).map(|rd| rd.count()).unwrap_or(0);
        assert_eq!(n, 1, "exactly one persistent preview blob written");
        let png2 = render_design_preview(&dir, &layers, &overrides, 128).expect("cache hit ok");
        assert_eq!(png, png2, "second call returns the cached bytes");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn render_design_preview_key_depends_on_color() {
        let dir = std::env::temp_dir().join(format!("cuprum-preview-c-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let layers = vec![PreviewLayer {
            layer_type: "topCopper".to_string(),
            bytes: GBR.to_vec(),
        }];
        let mut a = std::collections::HashMap::new();
        a.insert("topCopper".to_string(), "#ff0000".to_string());
        let mut b = std::collections::HashMap::new();
        b.insert("topCopper".to_string(), "#00ff00".to_string());
        let _ = render_design_preview(&dir, &layers, &a, 128).unwrap();
        let _ = render_design_preview(&dir, &layers, &b, 128).unwrap();
        let n = std::fs::read_dir(dir.join("preview"))
            .map(|rd| rd.count())
            .unwrap_or(0);
        assert_eq!(n, 2, "different colors → different keys → two blobs");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
