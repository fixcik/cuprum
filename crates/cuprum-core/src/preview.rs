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

/// Bottom-side layer types — excluded from the (top-only) card thumbnail.
fn is_bottom_side(layer_type: &str) -> bool {
    matches!(
        layer_type,
        "bottomCopper" | "bottomMask" | "bottomSilk" | "bottomPaste"
    )
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

/// Assemble a self-contained colored SVG document from per-layer fragments,
/// replicating the frontend `LayerStack` composition for design-card thumbnails:
///
/// 1. An opaque FR4 substrate rectangle over the full board bbox.
/// 2. Top-side layers only (bottom-side excluded), drawn in z-order:
///    - Regular layers: tinted with their layer color.
///    - Soldermask (`topMask`): inverted coverage — the mask color covers the
///      whole board at 82% opacity, with the gerber openings cut out via an SVG
///      `<mask>`, so copper shows at pads and green everywhere else.
///
/// Coordinates are mm; the root flips Y (gerber Y-up → SVG Y-down) via a
/// translate+scale transform so fragments' absolute-mm geometry renders upright.
///
/// `board_outline`, when present, is the real board outline as an SVG path `d`
/// (gerber mm) plus its bbox. The path clips the substrate, soldermask and tinted
/// layers so they follow the rounded edge instead of spilling to the rectangular
/// bbox (edge cuts stay unclipped — they ARE the outline; mirrors the frontend
/// `LayerStack` clip), and the bbox frames the view so the rasterized extent equals
/// the board bbox. Absent → union-of-layers bbox framing and no clipping.
pub fn compose_svg(
    layers: &[(String, LayerGeometry)],
    overrides: &HashMap<String, String>,
    board_outline: Option<(&str, BBox)>,
) -> String {
    // Frame the view to the board outline when available, so the rasterized PNG's
    // extent equals the board bbox the panel uses for instance placement; otherwise
    // fall back to the union bbox over ALL layers (silk overhang included).
    let frame = board_outline
        .map(|(_, bb)| bb)
        .or_else(|| union_bbox(layers));
    let Some(bb) = frame else {
        return r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>"#.to_string();
    };
    let board_clip = board_outline.map(|(d, _)| d);
    let w = (bb.max_x - bb.min_x).max(f32::MIN_POSITIVE);
    let h = (bb.max_y - bb.min_y).max(f32::MIN_POSITIVE);
    let minx = trim(bb.min_x);
    let miny = trim(bb.min_y);
    let ws = trim(w);
    let hs = trim(h);

    // Draw order: top-side layers only, sorted by z-order (stable for ties).
    let mut idx: Vec<usize> = (0..layers.len())
        .filter(|&i| !is_bottom_side(&layers[i].0))
        .collect();
    idx.sort_by_key(|&i| z_order(&layers[i].0));

    let mut out = String::new();
    let _ = write!(
        out,
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="{minx} {miny} {ws} {hs}">"#,
    );
    // Flip Y about the bbox: translate to top, scale Y by -1. Done as a group
    // transform so fragment coordinates stay in absolute mm.
    let _ = write!(
        out,
        r#"<g transform="translate(0,{ty}) scale(1,-1)">"#,
        ty = trim(bb.min_y + bb.max_y),
    );

    // Board-shaped clip (rounded Edge_Cuts outline) so the substrate/mask/layers
    // follow the real edge instead of the rectangular bbox. userSpaceOnUse → its
    // path coords share the (flipped) gerber-mm space of the elements it clips.
    let clip_attr = if board_clip.is_some() {
        r#" clip-path="url(#board-clip)""#
    } else {
        ""
    };
    if let Some(d) = board_clip {
        // evenodd so inner cutout loops punch holes regardless of winding order
        // (stitch() doesn't normalize direction; nonzero would fill them in).
        let _ = write!(
            out,
            r#"<clipPath id="board-clip" clipPathUnits="userSpaceOnUse"><path fill-rule="evenodd" d="{d}"/></clipPath>"#,
        );
    }

    // FR4 substrate: opaque tan rectangle covering the full board extent.
    out.push_str(&format!(
        "<rect x=\"{minx}\" y=\"{miny}\" width=\"{ws}\" height=\"{hs}\" fill=\"#59512c\"{clip_attr}/>",
    ));

    for (draw_idx, &i) in idx.iter().enumerate() {
        let (lt, g) = &layers[i];
        let color = resolve_color(lt, overrides);
        if lt == "topMask" || lt == "bottomMask" {
            // Inverted coverage: the mask color covers the whole board, with the
            // gerber openings (pads/vias) cut out so copper shows through.
            let mask_id = format!("mask-open-{draw_idx}");
            out.push_str(&format!(
                "<mask id=\"{mask_id}\" maskUnits=\"userSpaceOnUse\" \
x=\"{minx}\" y=\"{miny}\" width=\"{ws}\" height=\"{hs}\">\
<rect x=\"{minx}\" y=\"{miny}\" width=\"{ws}\" height=\"{hs}\" fill=\"#fff\"/>\
<g fill=\"#000\" stroke=\"#000\" color=\"#000\">{body}</g>\
</mask>\
<rect x=\"{minx}\" y=\"{miny}\" width=\"{ws}\" height=\"{hs}\" \
fill=\"{color}\" fill-opacity=\"0.82\" mask=\"url(#{mask_id})\"{clip_attr}/>",
                mask_id = mask_id,
                minx = minx,
                miny = miny,
                ws = ws,
                hs = hs,
                body = g.svg_body,
                color = color,
                clip_attr = clip_attr,
            ));
        } else {
            // Edge cuts ARE the outline — never clip them; everything else is
            // clipped to the board shape.
            let layer_clip = if lt == "edgeCuts" { "" } else { clip_attr };
            let _ = write!(
                out,
                "<g{layer_clip} fill=\"{c}\" stroke=\"{c}\" color=\"{c}\">{body}</g>",
                layer_clip = layer_clip,
                c = color,
                body = g.svg_body,
            );
        }
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

/// SVG clip-path `d` (gerber mm) for the board outline AND its bounding box, both
/// derived from the same Edge_Cuts loop reconstruction (`mesh::outline_info`) so the
/// clip and the frame agree (and match the 3D substrate). Every Edge_Cuts loop is a
/// closed subpath; the compound path is meant to be filled `evenodd` so inner
/// cutouts punch holes regardless of winding. `None` when the edge layer has no
/// stitchable loop, or the perimeter didn't close (a malformed/partial outline would
/// auto-close into a bogus shape — fall back to no outline, i.e. union-bbox framing
/// and no clipping).
fn board_outline(edge_bytes: &[u8]) -> Option<(String, BBox)> {
    let (loops, perimeter_closed) = crate::mesh::outline_info(edge_bytes);
    if !perimeter_closed {
        return None;
    }
    let mut d = String::new();
    let (mut min_x, mut min_y) = (f32::INFINITY, f32::INFINITY);
    let (mut max_x, mut max_y) = (f32::NEG_INFINITY, f32::NEG_INFINITY);
    for ring in loops.iter().filter(|r| r.len() >= 3) {
        for (i, p) in ring.iter().enumerate() {
            let (x, y) = (p[0] as f32, p[1] as f32);
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
            let _ = write!(
                d,
                "{}{} {} ",
                if i == 0 { "M" } else { "L" },
                trim(x),
                trim(y)
            );
        }
        d.push_str("Z ");
    }
    let d = d.trim_end();
    if d.is_empty() || !min_x.is_finite() {
        return None;
    }
    Some((
        d.to_string(),
        BBox {
            min_x,
            min_y,
            max_x,
            max_y,
        },
    ))
}

/// One layer feeding the composite: raw gerber bytes + its IPC layer-type string.
#[derive(Clone)]
pub struct PreviewLayer {
    pub layer_type: String,
    pub bytes: Vec<u8>,
}

/// Raster size (longest side, px) of the design-card preview. Shared between
/// the renderer's callers and the pack-gc valid-set reconstruction in
/// `cuprum-project` so both derive the same cache key.
pub const CARD_PREVIEW_MAX_PX: u32 = 512;

/// Detailed (panel-editor) preview density: pixels per board millimetre.
pub const DETAILED_PREVIEW_PX_PER_MM: f32 = 12.0;
/// Hard cap on the longest side of the detailed preview, px. Guards a huge board
/// against a multi-hundred-megapixel raster.
pub const DETAILED_PREVIEW_MAX_PX: u32 = 4096;

/// How a preview is sized from the board's millimetre extents.
#[derive(Clone, Copy)]
pub enum PreviewSizing {
    /// Longest side fixed to N px (card thumbnail).
    MaxPx(u32),
    /// N px per board-mm, longest side clamped to `cap_px` (detailed editor view).
    Density { px_per_mm: f32, cap_px: u32 },
}

/// Compute the raster (width_px, height_px, scale) for a board of the given mm
/// extents under `sizing`. `scale` is px-per-mm actually applied.
fn scaled_dims(width_mm: f32, height_mm: f32, sizing: PreviewSizing) -> (u32, u32, f32) {
    let longest = width_mm.max(height_mm).max(1.0);
    let scale = match sizing {
        PreviewSizing::MaxPx(n) => (n as f32) / longest,
        PreviewSizing::Density { px_per_mm, cap_px } => {
            let s = px_per_mm;
            if longest * s > cap_px as f32 {
                (cap_px as f32) / longest
            } else {
                s
            }
        }
    };
    let w = (width_mm * scale).ceil().max(1.0) as u32;
    let h = (height_mm * scale).ceil().max(1.0) as u32;
    (w, h, scale)
}

/// Content-hash key for a design's preview: version + raster size + each
/// layer's (type, color, gerber-content), sorted by `(layer_type, bytes)` so
/// input order never changes the key. Shared with `artifact::gc`'s valid set.
/// `max_px` is part of the key because the cached PNG is rasterized to that
/// size — the same layers at a different size are a different artifact.
pub fn preview_key(
    layers: &[PreviewLayer],
    overrides: &HashMap<String, String>,
    max_px: u32,
) -> String {
    let mut h = crate::diskcache::Hasher::new();
    h.add(crate::artifact::PREVIEW_VERSION);
    h.add(&max_px.to_le_bytes());
    let mut sorted: Vec<&PreviewLayer> = layers.iter().collect();
    sorted.sort_by(|a, b| {
        a.layer_type
            .cmp(&b.layer_type)
            .then_with(|| a.bytes.cmp(&b.bytes))
    });
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
    let key = preview_key(layers, overrides, max_px);
    let dir = artifacts_dir.join("preview");
    if !crate::diskcache::cache_disabled() {
        if let Some(png) = crate::diskcache::get_persistent(&dir, &key) {
            return Ok(png);
        }
    }
    // Reuse the shared per-layer SVG artifact cache (same content key as the
    // inspector's `cache::layer_svg_artifact`) instead of re-rendering each layer
    // here. On a cold card show the preview and inspector then render a given layer
    // exactly once between them — single-flight de-dups even when they run
    // concurrently. The internal SVG element id differs from a direct render but is
    // invisible in the raster, so the composed PNG is byte-identical (no version bump).
    // Skip layers whose gerber fails to parse (blank silk/paste is common) so
    // one bad layer doesn't abort the whole preview.
    let svg_dir = artifacts_dir.join("svg");
    let mut composed: Vec<(String, LayerGeometry)> = Vec::with_capacity(layers.len());
    for l in layers {
        match crate::cache::layer_svg_artifact(&svg_dir, &l.bytes) {
            Ok(g) => composed.push((l.layer_type.clone(), g)),
            Err(_) => continue,
        }
    }
    // Reconstruct the board outline from Edge_Cuts so the composite clips to the
    // real (rounded) shape instead of the rectangular bbox — matches the inspector.
    let board_outline = layers
        .iter()
        .find(|l| l.layer_type == "edgeCuts")
        .and_then(|e| board_outline(&e.bytes));
    let doc = compose_svg(
        &composed,
        overrides,
        board_outline.as_ref().map(|(d, bb)| (d.as_str(), *bb)),
    );
    let png = rasterize(&doc, max_px)?;
    if !crate::diskcache::cache_disabled() {
        crate::diskcache::put_persistent(&dir, &key, &png);
    }
    Ok(png)
}

/// Quantize an RGBA pixmap to a <=256-colour palette and encode an indexed
/// (PNG-8) image. A tRNS chunk carries per-entry alpha so transparency outside
/// the board outline survives. The layer palette is narrow, so quantization is
/// visually lossless at preview densities.
fn encode_indexed_png(pixmap: &resvg::tiny_skia::Pixmap) -> anyhow::Result<Vec<u8>> {
    let (w, h) = (pixmap.width(), pixmap.height());
    // tiny-skia stores premultiplied alpha; imagequant wants straight RGBA.
    let rgba: Vec<imagequant::RGBA> = pixmap
        .pixels()
        .iter()
        .map(|p| {
            let c = p.demultiply();
            imagequant::RGBA::new(c.red(), c.green(), c.blue(), c.alpha())
        })
        .collect();

    let mut liq = imagequant::new();
    liq.set_quality(0, 100)
        .map_err(|e| anyhow::anyhow!("liq quality: {e:?}"))?;
    let mut img = liq
        .new_image(rgba.as_slice(), w as usize, h as usize, 0.0)
        .map_err(|e| anyhow::anyhow!("liq image: {e:?}"))?;
    let mut res = liq
        .quantize(&mut img)
        .map_err(|e| anyhow::anyhow!("liq quantize: {e:?}"))?;
    res.set_dithering_level(1.0)
        .map_err(|e| anyhow::anyhow!("liq dither: {e:?}"))?;
    let (palette, indices) = res
        .remapped(&mut img)
        .map_err(|e| anyhow::anyhow!("liq remap: {e:?}"))?;

    // Split palette into PLTE (rgb triples) + tRNS (alpha bytes). Trailing fully
    // opaque entries can be dropped from tRNS, but emitting all is simplest/correct.
    let mut plte = Vec::with_capacity(palette.len() * 3);
    let mut trns = Vec::with_capacity(palette.len());
    for c in &palette {
        plte.push(c.r);
        plte.push(c.g);
        plte.push(c.b);
        trns.push(c.a);
    }

    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Indexed);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_palette(plte);
        enc.set_trns(trns);
        let mut writer = enc
            .write_header()
            .map_err(|e| anyhow::anyhow!("png header: {e}"))?;
        writer
            .write_image_data(&indices)
            .map_err(|e| anyhow::anyhow!("png data: {e}"))?;
    }
    Ok(out)
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
    fn indexed_png_roundtrips_with_alpha() {
        // 2x2: opaque red, opaque green, fully transparent, opaque red again.
        let mut pm = resvg::tiny_skia::Pixmap::new(2, 2).unwrap();
        let px = pm.pixels_mut();
        px[0] = resvg::tiny_skia::PremultipliedColorU8::from_rgba(200, 0, 0, 255).unwrap();
        px[1] = resvg::tiny_skia::PremultipliedColorU8::from_rgba(0, 180, 0, 255).unwrap();
        px[2] = resvg::tiny_skia::PremultipliedColorU8::from_rgba(0, 0, 0, 0).unwrap();
        px[3] = resvg::tiny_skia::PremultipliedColorU8::from_rgba(200, 0, 0, 255).unwrap();

        let bytes = encode_indexed_png(&pm).expect("encode");

        let dec = png::Decoder::new(std::io::Cursor::new(&bytes));
        let mut reader = dec.read_info().expect("read_info");
        let info = reader.info();
        assert_eq!(info.color_type, png::ColorType::Indexed, "must be indexed PNG-8");
        assert_eq!(info.bit_depth, png::BitDepth::Eight);
        assert!(!info.palette.as_ref().unwrap().is_empty(), "palette present");
        assert!(info.palette.as_ref().unwrap().len() / 3 <= 256, "<=256 colours");
        // A tRNS chunk must exist because one pixel is fully transparent.
        assert!(info.trns.is_some(), "tRNS present for transparency");
        assert!(
            info.trns.as_ref().unwrap().iter().any(|&a| a == 0),
            "some palette entry is fully transparent"
        );

        let mut buf = vec![0u8; reader.output_buffer_size()];
        reader.next_frame(&mut buf).expect("decode frame");
    }

    #[test]
    fn scaled_dims_max_px_fits_longest_side() {
        // 100x80 mm, MaxPx(512): longest side -> 512.
        let (w, h, _s) = scaled_dims(100.0, 80.0, PreviewSizing::MaxPx(512));
        assert_eq!(w, 512);
        assert_eq!(h, 410); // ceil(80 * 512/100) = ceil(409.6)
    }

    #[test]
    fn scaled_dims_density_multiplies_mm() {
        // 100x50 mm at 12 px/mm, far below cap.
        let (w, h, s) = scaled_dims(100.0, 50.0, PreviewSizing::Density { px_per_mm: 12.0, cap_px: 4096 });
        assert_eq!(w, 1200);
        assert_eq!(h, 600);
        assert!((s - 12.0).abs() < 1e-6);
    }

    #[test]
    fn scaled_dims_density_clamps_at_cap() {
        // 500 mm at 12 px/mm would be 6000 px; cap 4096 forces longest side to 4096.
        let (w, _h, s) = scaled_dims(500.0, 100.0, PreviewSizing::Density { px_per_mm: 12.0, cap_px: 4096 });
        assert_eq!(w, 4096);
        assert!(s < 12.0, "scale reduced below density when capped");
    }

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
        let doc = compose_svg(&layers, &overrides, None);
        assert!(doc.starts_with("<svg"), "standalone svg root");
        assert!(
            doc.contains("viewBox=\"0 0 10 8\""),
            "viewBox from union bbox: got {doc}"
        );
        // FR4 substrate rect comes before any layer body.
        let fr4 = doc.find("#59512c").expect("FR4 substrate color present");
        let edge = doc.find("<rect/>").expect("edge body present");
        let cu = doc.find("<circle/>").expect("copper body present");
        assert!(fr4 < edge, "FR4 substrate drawn before edge cuts");
        assert!(edge < cu, "edgeCuts drawn before copper (under it)");
        assert!(doc.contains("#caa84a"), "copper color applied");
        assert!(
            doc.contains("scale(1,-1)") || doc.contains("matrix"),
            "Y flip present"
        );
    }

    #[test]
    fn compose_mask_is_inverted_coverage() {
        let layers = vec![
            (
                "topCopper".to_string(),
                geom("<circle/>", 0.0, 0.0, 10.0, 8.0),
            ),
            (
                "topMask".to_string(),
                geom("<circle/>", 0.0, 0.0, 10.0, 8.0),
            ),
        ];
        let overrides = std::collections::HashMap::new();
        let doc = compose_svg(&layers, &overrides, None);
        // Mask renders as inverted coverage: a <mask> def + a coverage rect at 0.82.
        assert!(
            doc.contains("<mask"),
            "mask layer uses an SVG <mask>: {doc}"
        );
        assert!(
            doc.contains("fill-opacity=\"0.82\""),
            "mask coverage at 0.82 opacity"
        );
        assert!(doc.contains("#257d55"), "soldermask green present");
        // FR4 substrate present underneath.
        assert!(doc.contains("#59512c"), "FR4 substrate present");
    }

    // A 10×10 mm square Edge_Cuts outline (four D01 line moves), 2.4 mm format.
    const EDGE_SQUARE: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.15*%\nD10*\nX0Y0D02*\nX100000Y0D01*\nX100000Y100000D01*\nX0Y100000D01*\nX0Y0D01*\nM02*\n";
    // An L-shaped OPEN chain (three points, never returns to start).
    const EDGE_OPEN: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.15*%\nD10*\nX0Y0D02*\nX100000Y0D01*\nX100000Y100000D01*\nM02*\n";

    #[test]
    fn board_outline_reports_path_and_bbox() {
        let (d, bb) = board_outline(EDGE_SQUARE).expect("square stitches into a loop");
        assert!(d.starts_with('M'), "clip path starts with a moveto: {d}");
        assert!(d.contains('Z'), "clip path closes the loop: {d}");
        assert!(
            bb.min_x.abs() < 1e-3 && (bb.max_x - 10.0).abs() < 1e-3,
            "x spans 0..10: {bb:?}"
        );
        assert!(
            bb.min_y.abs() < 1e-3 && (bb.max_y - 10.0).abs() < 1e-3,
            "y spans 0..10: {bb:?}"
        );
        // Empty/garbage edge bytes → no outline (graceful).
        assert!(
            board_outline(b"M02*\n").is_none(),
            "no segments → no outline"
        );
        // Open/partial perimeter → no outline (don't clip to a bogus auto-closed shape).
        assert!(
            board_outline(EDGE_OPEN).is_none(),
            "open perimeter falls back to no outline"
        );
    }

    #[test]
    fn compose_frames_view_to_outline_not_union() {
        // Silk overhangs the 10×10 board; framing must follow the outline bbox, not
        // the union of layer bboxes, so the PNG extent equals the board placement size.
        let layers = vec![
            (
                "edgeCuts".to_string(),
                geom("<rect/>", 0.0, 0.0, 10.0, 10.0),
            ),
            (
                "topSilk".to_string(),
                geom("<text/>", -2.0, -1.0, 15.0, 12.0),
            ),
        ];
        let o = std::collections::HashMap::new();
        let (d, bb) = board_outline(EDGE_SQUARE).unwrap();
        let doc = compose_svg(&layers, &o, Some((&d, bb)));
        assert!(
            doc.contains("viewBox=\"0 0 10 10\""),
            "framed to outline bbox: {doc}"
        );
        // No outline → union bbox (overhang included), preserving old behavior.
        let plain = compose_svg(&layers, &o, None);
        assert!(
            plain.contains("viewBox=\"-2 -1 17 13\""),
            "union bbox fallback: {plain}"
        );
    }

    #[test]
    fn compose_clips_substrate_and_layers_but_not_edge_cuts() {
        let layers = vec![
            (
                "edgeCuts".to_string(),
                geom("<rect id=\"edge\"/>", 0.0, 0.0, 10.0, 10.0),
            ),
            (
                "topCopper".to_string(),
                geom("<circle id=\"cu\"/>", 0.0, 0.0, 10.0, 10.0),
            ),
        ];
        let overrides = std::collections::HashMap::new();
        let (d, bb) = board_outline(EDGE_SQUARE).unwrap();
        let doc = compose_svg(&layers, &overrides, Some((&d, bb)));
        assert!(doc.contains("id=\"board-clip\""), "clipPath defined: {doc}");
        assert!(
            doc.contains("fill-rule=\"evenodd\""),
            "clip path uses evenodd so inner cutouts punch holes: {doc}"
        );
        // Substrate rect carries the clip.
        assert!(
            doc.contains("fill=\"#59512c\" clip-path=\"url(#board-clip)\""),
            "substrate clipped to the board outline: {doc}"
        );
        // Copper group is clipped (clip-path precedes fill in the opening tag).
        assert!(
            doc.contains("<g clip-path=\"url(#board-clip)\" fill=\"#caa84a\""),
            "copper clipped: {doc}"
        );
        // Edge-cuts group is the UNCLIPPED form (no clip-path before its fill).
        assert!(
            doc.contains("<g fill=\"#59512c\" stroke=\"#59512c\""),
            "edge cuts group present: {doc}"
        );
        assert!(
            !doc.contains("clip-path=\"url(#board-clip)\" fill=\"#59512c\""),
            "edge cuts left unclipped: {doc}"
        );
        // No clip when none supplied.
        let plain = compose_svg(&layers, &overrides, None);
        assert!(!plain.contains("clip-path"), "no clip without an outline");
    }

    #[test]
    fn compose_excludes_bottom_side() {
        let layers = vec![
            (
                "topCopper".to_string(),
                geom("<circle id=\"top\"/>", 0.0, 0.0, 10.0, 8.0),
            ),
            (
                "bottomCopper".to_string(),
                geom("<circle id=\"bot\"/>", 0.0, 0.0, 10.0, 8.0),
            ),
        ];
        let doc = compose_svg(&layers, &std::collections::HashMap::new(), None);
        assert!(doc.contains("id=\"top\""), "top layer drawn");
        assert!(
            !doc.contains("id=\"bot\""),
            "bottom layer excluded from top-only thumbnail"
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
    fn preview_key_is_order_independent() {
        let a = vec![
            PreviewLayer {
                layer_type: "topCopper".into(),
                bytes: b"AAAA".to_vec(),
            },
            PreviewLayer {
                layer_type: "topMask".into(),
                bytes: b"BBBB".to_vec(),
            },
        ];
        let mut b = a.clone();
        b.reverse();
        let o = std::collections::HashMap::new();
        assert_eq!(
            preview_key(&a, &o, 128),
            preview_key(&b, &o, 128),
            "key independent of input order"
        );
    }

    #[test]
    fn preview_key_depends_on_max_px() {
        let layers = vec![PreviewLayer {
            layer_type: "topCopper".into(),
            bytes: b"AAAA".to_vec(),
        }];
        let o = std::collections::HashMap::new();
        assert_ne!(
            preview_key(&layers, &o, 128),
            preview_key(&layers, &o, 512),
            "same layers at a different raster size must key differently"
        );
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

    #[test]
    fn render_design_preview_populates_shared_svg_cache() {
        // A unique aperture diameter no other test uses → guaranteed-cold svg cache
        // key, so the per-layer render must miss and land a blob on disk.
        const UNIQ: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.234*%\nD10*\nX0Y0D03*\nM02*\n";
        let dir =
            std::env::temp_dir().join(format!("cuprum-preview-svgcache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let layers = vec![PreviewLayer {
            layer_type: "topCopper".to_string(),
            bytes: UNIQ.to_vec(),
        }];
        let overrides = std::collections::HashMap::new();
        let _ = render_design_preview(&dir, &layers, &overrides, 128).expect("preview ok");
        // The preview routed the layer through the shared artifact cache, so its SVG
        // blob lands under <dir>/svg/<svg_artifact_key>.bin — the SAME key/path the
        // inspector would use, proving the layer renders once across both.
        let svg_blob = dir
            .join("svg")
            .join(format!("{}.bin", crate::cache::svg_artifact_key(UNIQ)));
        assert!(
            svg_blob.exists(),
            "preview reuses the shared per-layer SVG cache (blob at {svg_blob:?})"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
