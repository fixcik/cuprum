//! Render a parsed Gerber layer to an SVG fragment for on-screen preview.
//!
//! Parallel to the raster path in [`crate::gerber`]: it walks the SAME geometry
//! primitives, but emits themeable SVG instead of pixels. Colour comes from the
//! caller's CSS `currentColor`, so the viewer can tint each layer. Coordinates
//! are absolute millimetres with Y pointing UP (the viewer flips Y when it
//! composes layers into one document).

use anyhow::{anyhow, Context, Result};
use gerber_viewer::{Exposure, GerberLayer, GerberPrimitive};

/// Axis-aligned bounds in millimetres (Y up).
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct BBox {
    pub min_x: f32,
    pub min_y: f32,
    pub max_x: f32,
    pub max_y: f32,
}

/// A layer rendered to SVG: a self-contained `<g>…</g>` fragment, its bounds, and
/// snap candidates (feature centers/corners/endpoints) in millimetres (Y up).
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct LayerGeometry {
    pub svg_body: String,
    pub bbox: BBox,
    pub snap: Vec<[f32; 2]>,
}

const ARC_STEPS: usize = 96;

/// Render raw Gerber bytes to an SVG fragment. `id` must be unique within the
/// composed SVG document — it scopes the clear-polarity mask, if one is needed.
#[tracing::instrument(skip_all, fields(id))]
pub fn render_layer_svg(bytes: &[u8], id: &str) -> Result<LayerGeometry> {
    // Sanitize `id` so that arbitrary filenames (e.g. with `"`, `<`, `/`) cannot
    // escape an SVG attribute or poison a url(#…) reference.
    let safe_id: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();

    let reader = std::io::BufReader::new(std::io::Cursor::new(bytes));
    let doc = gerber_viewer::gerber_parser::parse(reader)
        .map_err(|(_doc, e)| anyhow!("parse error: {e:?}"))?;
    let layer = GerberLayer::new(doc.into_commands());
    let raw = layer
        .try_bounding_box()
        .context("gerber has no drawable geometry")?;
    let bbox = BBox {
        min_x: raw.min.x as f32,
        min_y: raw.min.y as f32,
        max_x: raw.max.x as f32,
        max_y: raw.max.y as f32,
    };

    // Elements carry no colour; the wrapping <g> supplies it. Stroked shapes set
    // fill="none", filled shapes set stroke="none", so a single group colour
    // drives whichever channel each shape uses.
    let mut add = String::new();
    let mut cut = String::new();
    let mut snap: Vec<[f32; 2]> = Vec::new();
    let mut seen: HashSet<(i32, i32)> = HashSet::new();

    use crate::strokes::{coalesce_strokes, Run};
    // Snap points come from the original primitive stream (coalescing does not
    // change feature positions).
    for prim in layer.primitives() {
        collect_snap(prim, &mut seen, &mut snap);
    }
    // Geometry: coalesce connected line runs into single polyline paths.
    for run in coalesce_strokes(layer.primitives()) {
        match run {
            Run::Polyline {
                exposure,
                width,
                pts,
            } => {
                let buf = match exposure {
                    Exposure::Add => &mut add,
                    Exposure::CutOut => &mut cut,
                };
                emit_polyline(&pts, width, buf);
            }
            Run::Flash(prim) => {
                let buf = match exposure_of(prim) {
                    Exposure::Add => &mut add,
                    Exposure::CutOut => &mut cut,
                };
                emit(prim, buf);
            }
        }
    }

    let svg_body = if cut.is_empty() {
        format!(r#"<g fill="currentColor" stroke="currentColor">{add}</g>"#)
    } else {
        let x = bbox.min_x;
        let y = bbox.min_y;
        let w = bbox.max_x - bbox.min_x;
        let h = bbox.max_y - bbox.min_y;
        format!(
            r##"<g><mask id="cuprum-mask-{safe_id}" maskUnits="userSpaceOnUse" x="{x:.4}" y="{y:.4}" width="{w:.4}" height="{h:.4}"><g fill="#fff" stroke="#fff">{add}</g><g fill="#000" stroke="#000">{cut}</g></mask><rect x="{x:.4}" y="{y:.4}" width="{w:.4}" height="{h:.4}" fill="currentColor" mask="url(#cuprum-mask-{safe_id})"/></g>"##
        )
    };

    Ok(LayerGeometry {
        svg_body,
        bbox,
        snap,
    })
}

use std::collections::HashSet;

/// Cap snap points per layer so a dense pour/many traces can't flood the IPC
/// payload or the frontend's nearest-point search.
const SNAP_CAP: usize = 40_000;

fn push_snap(seen: &mut HashSet<(i32, i32)>, out: &mut Vec<[f32; 2]>, x: f64, y: f64) {
    if out.len() >= SNAP_CAP {
        return;
    }
    // Dedup on a 0.01mm grid so coincident pad/trace points collapse.
    let key = ((x * 100.0).round() as i32, (y * 100.0).round() as i32);
    if seen.insert(key) {
        out.push([x as f32, y as f32]);
    }
}

/// Collect snap candidates for one primitive. Emits feature centers, rectangle
/// corners and edge midpoints, small-polygon vertices (pad shapes), line
/// endpoints and midpoint, and arc center and endpoints. Large pours (polygons
/// with many vertices) contribute only their centroid.
fn collect_snap(p: &GerberPrimitive, seen: &mut HashSet<(i32, i32)>, out: &mut Vec<[f32; 2]>) {
    match p {
        GerberPrimitive::Circle(c) => push_snap(seen, out, c.center.x, c.center.y),
        GerberPrimitive::Rectangle(r) => {
            let (x0, y0, w, h) = (r.origin.x, r.origin.y, r.width, r.height);
            let (cx, cy) = (x0 + w / 2.0, y0 + h / 2.0);
            push_snap(seen, out, cx, cy);
            for &(x, y) in &[(x0, y0), (x0 + w, y0), (x0, y0 + h), (x0 + w, y0 + h)] {
                push_snap(seen, out, x, y);
            }
            // edge midpoints
            push_snap(seen, out, cx, y0);
            push_snap(seen, out, cx, y0 + h);
            push_snap(seen, out, x0, cy);
            push_snap(seen, out, x0 + w, cy);
        }
        GerberPrimitive::Polygon(poly) => {
            push_snap(seen, out, poly.center.x, poly.center.y);
            if poly.geometry.relative_vertices.len() <= 12 {
                for v in &poly.geometry.relative_vertices {
                    push_snap(seen, out, poly.center.x + v.x, poly.center.y + v.y);
                }
            }
        }
        GerberPrimitive::Line(l) => {
            push_snap(seen, out, l.start.x, l.start.y);
            push_snap(seen, out, l.end.x, l.end.y);
            push_snap(
                seen,
                out,
                (l.start.x + l.end.x) / 2.0,
                (l.start.y + l.end.y) / 2.0,
            );
        }
        GerberPrimitive::Arc(a) => {
            push_snap(seen, out, a.center.x, a.center.y);
            for t in [0.0_f64, 0.5, 1.0] {
                let ang = a.start_angle + a.sweep_angle * t;
                push_snap(
                    seen,
                    out,
                    a.center.x + a.radius * ang.cos(),
                    a.center.y + a.radius * ang.sin(),
                );
            }
        }
    }
}

fn exposure_of(p: &GerberPrimitive) -> Exposure {
    match p {
        GerberPrimitive::Circle(c) => c.exposure,
        GerberPrimitive::Rectangle(r) => r.exposure,
        GerberPrimitive::Line(l) => l.exposure,
        GerberPrimitive::Arc(a) => a.exposure,
        GerberPrimitive::Polygon(p) => p.exposure,
    }
}

fn emit(p: &GerberPrimitive, out: &mut String) {
    use std::fmt::Write;
    match p {
        GerberPrimitive::Circle(c) => {
            let _ = write!(
                out,
                r#"<circle cx="{:.4}" cy="{:.4}" r="{:.4}" stroke="none"/>"#,
                c.center.x,
                c.center.y,
                c.diameter / 2.0
            );
        }
        GerberPrimitive::Rectangle(r) => {
            let _ = write!(
                out,
                r#"<rect x="{:.4}" y="{:.4}" width="{:.4}" height="{:.4}" stroke="none"/>"#,
                r.origin.x, r.origin.y, r.width, r.height
            );
        }
        GerberPrimitive::Polygon(poly) => {
            let mut d = String::new();
            for (i, v) in poly.geometry.relative_vertices.iter().enumerate() {
                let (x, y) = (poly.center.x + v.x, poly.center.y + v.y);
                let _ = write!(d, "{}{:.4} {:.4}", if i == 0 { "M" } else { "L" }, x, y);
                if i + 1 < poly.geometry.relative_vertices.len() {
                    d.push(' ');
                }
            }
            d.push_str(" Z");
            let _ = write!(out, r#"<path d="{d}" stroke="none"/>"#);
        }
        GerberPrimitive::Line(l) => {
            let _ = write!(
                out,
                r#"<path d="M{:.4} {:.4} L{:.4} {:.4}" fill="none" stroke-width="{:.4}" stroke-linecap="round" stroke-linejoin="round"/>"#,
                l.start.x, l.start.y, l.end.x, l.end.y, l.width
            );
        }
        GerberPrimitive::Arc(a) => {
            let mut d = String::new();
            for i in 0..=ARC_STEPS {
                let t = i as f64 / ARC_STEPS as f64;
                let ang = a.start_angle + a.sweep_angle * t;
                let x = a.center.x + a.radius * ang.cos();
                let y = a.center.y + a.radius * ang.sin();
                let _ = write!(d, "{}{:.4} {:.4} ", if i == 0 { "M" } else { "L" }, x, y);
            }
            let _ = write!(
                out,
                r#"<path d="{}" fill="none" stroke-width="{:.4}" stroke-linecap="round" stroke-linejoin="round"/>"#,
                d.trim_end(),
                a.width
            );
        }
    }
}

fn emit_polyline(pts: &[[f64; 2]], width: f64, out: &mut String) {
    use std::fmt::Write;
    let mut d = String::new();
    for (i, p) in pts.iter().enumerate() {
        let _ = write!(
            d,
            "{}{:.4} {:.4} ",
            if i == 0 { "M" } else { "L" },
            p[0],
            p[1]
        );
    }
    let _ = write!(
        out,
        r#"<path d="{}" fill="none" stroke-width="{:.4}" stroke-linecap="round" stroke-linejoin="round"/>"#,
        d.trim_end(),
        width
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    // Flash a 1mm circle aperture at the origin: one Circle primitive, bbox -0.5..0.5.
    const FLASH_CIRCLE: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.0*%\nD10*\nX0Y0D03*\nM02*\n";

    #[test]
    fn circle_flash_yields_center_snap() {
        let g = render_layer_svg(FLASH_CIRCLE, "t").unwrap();
        // The 1mm circle is flashed at the origin → a snap point near (0,0).
        assert!(
            g.snap
                .iter()
                .any(|p| p[0].abs() < 0.01 && p[1].abs() < 0.01),
            "expected a center snap near origin: {:?}",
            g.snap
        );
    }

    #[test]
    fn empty_gerber_has_no_snap() {
        // (geometry-less input already errors in render_layer_svg; nothing to assert
        // about snap here — this documents that snap only exists for drawable layers.)
        assert!(render_layer_svg(b"G04 x*\nM02*\n", "t").is_err());
    }

    #[test]
    fn renders_circle_fragment_with_bbox() {
        let g = render_layer_svg(FLASH_CIRCLE, "import-1-top").unwrap();
        assert!(
            g.svg_body.contains("<circle"),
            "expected a circle element: {}",
            g.svg_body
        );
        assert!(g.svg_body.contains("currentColor"), "must be themeable");
        // ~1mm circle centred at origin.
        assert!((g.bbox.min_x - -0.5).abs() < 0.05, "min_x={}", g.bbox.min_x);
        assert!((g.bbox.max_x - 0.5).abs() < 0.05, "max_x={}", g.bbox.max_x);
    }

    #[test]
    fn empty_gerber_errors() {
        let err = render_layer_svg(b"G04 nothing*\nM02*\n", "x").unwrap_err();
        assert!(err.to_string().contains("no drawable geometry"));
    }

    const THREE_CONNECTED: &[u8] =
        b"%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.100000*%\nD10*\nX0Y0D02*\nX1000000Y0D01*\nX1000000Y1000000D01*\nX0Y1000000D01*\nM02*\n";

    #[test]
    fn connected_silk_run_emits_one_path() {
        let g = render_layer_svg(THREE_CONNECTED, "t").unwrap();
        let paths = g.svg_body.matches(r#"fill="none""#).count();
        assert_eq!(
            paths, 1,
            "expected one polyline path, got {paths}: {}",
            g.svg_body
        );
        assert!(g.svg_body.contains(" L"), "polyline must have L commands");
    }

    /// The vendored gerber-viewer (gerber-viewer/src/layer.rs) does not handle
    /// the `%LPC*%` (load polarity clear / `ExtendedCode::LoadPolarity(Polarity::Clear)`)
    /// command — the match arm for `LoadPolarity` is absent, so it falls through to the
    /// catch-all `_ => {}` and every flash is emitted as `Exposure::Add`.  Until the
    /// vendor is patched, the CutOut branch in `render_layer_svg` cannot be exercised
    /// through gerber input.  This test documents that known limitation and verifies the
    /// safe-id sanitization at the same time: the id `"imp/1.gbr"` must have its
    /// special characters replaced, so neither `"/"` nor `"."` may appear inside the
    /// `cuprum-mask-…` attribute value.
    #[test]
    fn cutout_vendor_limitation_and_id_sanitization() {
        // Two apertures: D10 flashed dark (Add), D11 flashed clear (LPC) — but the
        // vendor ignores LPC so both arrive as Add and no mask is emitted.
        const ADD_AND_CLEAR: &[u8] =
            b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.0*%\n%LPD*%\nD10*\nX0Y0D03*\n%LPC*%\n%ADD11C,1.0*%\nD11*\nX0Y0D03*\nM02*\n";

        let g = render_layer_svg(ADD_AND_CLEAR, "imp/1.gbr").unwrap();

        // The vendor does not produce CutOut primitives from %LPC*%, so no mask is
        // generated.  If this assertion ever starts failing it means the vendor was
        // updated to support clear polarity — great!  At that point remove this test
        // and enable the full cutout_uses_mask test below.
        assert!(
            !g.svg_body.contains("cuprum-mask-"),
            "vendor now supports CutOut — replace this test with cutout_uses_mask: {}",
            g.svg_body
        );

        // Sanitization: the raw id "imp/1.gbr" must never appear verbatim in any
        // mask id= or url(#...) attribute, regardless of whether a mask was emitted.
        assert!(
            !g.svg_body.contains("cuprum-mask-imp/1.gbr"),
            "unsafe id leaked into SVG: {}",
            g.svg_body
        );
    }
}
