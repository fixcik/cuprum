//! Gerber (RS-274X) parsing and rasterization to an exposure mask.
//!
//! We reuse the (vendored, MIT/Apache) `gerber_viewer` crate for the hard part —
//! parsing commands into geometry primitives (apertures, macros, regions,
//! polarity, coordinates). We own only the rasterizer: walk the primitives and
//! paint them into a `tiny-skia` Pixmap (white = UV on, black = UV off).

use std::fs::File;
use std::io::BufReader;
use std::path::Path;
use std::time::Instant;

use anyhow::{anyhow, Context, Result};
use gerber_viewer::gerber_types::Command;
use gerber_viewer::{Exposure, GerberLayer, GerberPrimitive};
use tiny_skia::{
    Color, FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Rect, Stroke, Transform,
};

/// Parse a `.gbr` file into a flat list of Gerber commands.
pub fn parse_file(path: &Path) -> Result<Vec<Command>> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let doc = gerber_viewer::gerber_parser::parse(reader)
        .map_err(|(_doc, e)| anyhow!("parse error: {e:?}"))?;
    Ok(doc.into_commands())
}

#[derive(Clone, Copy, Debug)]
pub struct RenderOptions {
    /// Output resolution, pixels per millimeter, X and Y (the screen pixel is
    /// anisotropic, so these differ for an exposure-ready mask).
    pub px_per_mm_x: f32,
    pub px_per_mm_y: f32,
    /// Blank border around the board, millimeters.
    pub margin_mm: f32,
    /// Mirror horizontally (emulsion-down contact so the board isn't reversed).
    pub mirror_x: bool,
    /// Invert black/white (positive vs negative photoresist).
    pub invert: bool,
}

impl RenderOptions {
    /// Square resolution (equal X/Y) — for visual previews on normal monitors.
    pub fn square(px_per_mm: f32) -> Self {
        Self {
            px_per_mm_x: px_per_mm,
            px_per_mm_y: px_per_mm,
            ..Self::default()
        }
    }
}

impl Default for RenderOptions {
    fn default() -> Self {
        // Default to the printer's native (anisotropic) pixel pitch so the mask
        // is exposure-ready: one output pixel == one LCD pixel.
        Self {
            px_per_mm_x: crate::goo::SCREEN_PX_PER_MM_X,
            px_per_mm_y: crate::goo::SCREEN_PX_PER_MM_Y,
            margin_mm: 1.0,
            mirror_x: false,
            invert: false,
        }
    }
}

/// Geometry of a rendered Gerber: the rasterized image size in pixels and the
/// real-world size of that image in millimeters (bounding box + 2×margin).
#[derive(Clone, Copy, Debug)]
pub struct RenderInfo {
    pub px_w: u32,
    pub px_h: u32,
    pub width_mm: f32,
    pub height_mm: f32,
}

/// Rasterize a parsed Gerber into a Pixmap (white = UV on / copper, black = off).
pub fn render(commands: Vec<Command>, opts: &RenderOptions) -> Result<Pixmap> {
    Ok(render_with_info(commands, opts)?.0)
}

/// Like [`render`], but also returns the image's pixel and millimeter geometry —
/// the UI needs the true mm size to place the board at 1:1 scale.
pub fn render_with_info(
    commands: Vec<Command>,
    opts: &RenderOptions,
) -> Result<(Pixmap, RenderInfo)> {
    let layer = GerberLayer::new(commands);
    render_layer(&layer, opts)
}

/// Rasterize an already-built `GerberLayer` (lets callers that also need the
/// bounding box build the layer once — `GerberLayer::new` regenerates every
/// primitive and is the expensive step).
pub fn render_layer(layer: &GerberLayer, opts: &RenderOptions) -> Result<(Pixmap, RenderInfo)> {
    let bbox = layer
        .try_bounding_box()
        .context("gerber has no drawable geometry")?;

    let margin = opts.margin_mm as f64;
    let min_x = bbox.min.x - margin;
    let max_y = bbox.max.y + margin;
    let w_mm = bbox.width() + 2.0 * margin;
    let h_mm = bbox.height() + 2.0 * margin;
    let sx = opts.px_per_mm_x as f64;
    let sy = opts.px_per_mm_y as f64;

    let pw = ((w_mm * sx).ceil() as u32).max(1);
    let ph = ((h_mm * sy).ceil() as u32).max(1);
    let mut pm = Pixmap::new(pw, ph).context("failed to allocate pixmap (too large?)")?;
    pm.fill(Color::BLACK);

    // Single mm -> pixel transform: anisotropic scale, Y flipped, optional X mirror.
    // Paths are built in mm; tiny-skia applies this transform (so a round aperture
    // correctly becomes an ellipse on the non-square pixel grid).
    let tf = if opts.mirror_x {
        Transform::from_row(
            -sx as f32,
            0.0,
            0.0,
            -sy as f32,
            (sx * (w_mm + min_x)) as f32,
            (sy * max_y) as f32,
        )
    } else {
        Transform::from_row(
            sx as f32,
            0.0,
            0.0,
            -sy as f32,
            (-sx * min_x) as f32,
            (sy * max_y) as f32,
        )
    };

    let mut white = Paint::default();
    white.set_color(Color::WHITE);
    white.anti_alias = true;
    let mut black = Paint::default();
    black.set_color(Color::BLACK);
    black.anti_alias = true;
    let paint_for = |exp: Exposure| -> &Paint {
        match exp {
            Exposure::Add => &white,
            Exposure::CutOut => &black,
        }
    };
    let stroke_mm = |w: f64| Stroke {
        width: w as f32,
        line_cap: LineCap::Round,
        line_join: LineJoin::Round,
        ..Default::default()
    };

    for prim in layer.primitives() {
        match prim {
            GerberPrimitive::Circle(c) => {
                if let Some(path) = PathBuilder::from_circle(
                    c.center.x as f32,
                    c.center.y as f32,
                    (c.diameter / 2.0) as f32,
                ) {
                    pm.fill_path(&path, paint_for(c.exposure), FillRule::Winding, tf, None);
                }
            }
            GerberPrimitive::Rectangle(r) => {
                if let Some(rect) = Rect::from_xywh(
                    r.origin.x as f32,
                    r.origin.y as f32,
                    r.width as f32,
                    r.height as f32,
                ) {
                    let mut pb = PathBuilder::new();
                    pb.push_rect(rect);
                    if let Some(path) = pb.finish() {
                        pm.fill_path(&path, paint_for(r.exposure), FillRule::Winding, tf, None);
                    }
                }
            }
            GerberPrimitive::Line(l) => {
                let mut pb = PathBuilder::new();
                pb.move_to(l.start.x as f32, l.start.y as f32);
                pb.line_to(l.end.x as f32, l.end.y as f32);
                if let Some(path) = pb.finish() {
                    pm.stroke_path(&path, paint_for(l.exposure), &stroke_mm(l.width), tf, None);
                }
            }
            GerberPrimitive::Polygon(p) => {
                let mut pb = PathBuilder::new();
                for (i, v) in p.geometry.relative_vertices.iter().enumerate() {
                    let (x, y) = ((p.center.x + v.x) as f32, (p.center.y + v.y) as f32);
                    if i == 0 {
                        pb.move_to(x, y);
                    } else {
                        pb.line_to(x, y);
                    }
                }
                pb.close();
                if let Some(path) = pb.finish() {
                    pm.fill_path(&path, paint_for(p.exposure), FillRule::Winding, tf, None);
                }
            }
            GerberPrimitive::Arc(a) => {
                let steps = 96usize;
                let mut pb = PathBuilder::new();
                for i in 0..=steps {
                    let t = i as f64 / steps as f64;
                    let ang = a.start_angle + a.sweep_angle * t;
                    let x = (a.center.x + a.radius * ang.cos()) as f32;
                    let y = (a.center.y + a.radius * ang.sin()) as f32;
                    if i == 0 {
                        pb.move_to(x, y);
                    } else {
                        pb.line_to(x, y);
                    }
                }
                if let Some(path) = pb.finish() {
                    pm.stroke_path(&path, paint_for(a.exposure), &stroke_mm(a.width), tf, None);
                }
            }
        }
    }

    if opts.invert {
        for px in pm.data_mut().chunks_exact_mut(4) {
            px[0] = 255 - px[0];
            px[1] = 255 - px[1];
            px[2] = 255 - px[2];
        }
    }

    let info = RenderInfo {
        px_w: pw,
        px_h: ph,
        width_mm: w_mm as f32,
        height_mm: h_mm as f32,
    };
    Ok((pm, info))
}

/// True bounding-box size of the artwork in millimeters (no margin).
pub fn bounds_mm(commands: &[Command]) -> Result<(f32, f32)> {
    let layer = GerberLayer::new(commands.to_vec());
    let bbox = layer
        .try_bounding_box()
        .context("gerber has no drawable geometry")?;
    Ok((bbox.width() as f32, bbox.height() as f32))
}

/// Render a Gerber to a PNG sized for an on-screen preview (square pitch chosen so
/// the longest side ≈ `max_px`), returning the PNG bytes plus the true mm size.
/// The preview uses a square pitch (anisotropy only matters for the exposure
/// raster); the UI stretches the image into its true mm box, so geometry stays 1:1.
pub fn render_preview_png(path: &Path, max_px: u32) -> Result<(Vec<u8>, RenderInfo, String)> {
    let t0 = Instant::now();
    let commands = parse_file(path)?;
    let n_cmds = commands.len();
    let t_parse = t0.elapsed();

    // Build the layer once (regenerating primitives is the costly step); reuse it
    // for both the bounding box and the raster.
    let layer = GerberLayer::new(commands);
    let bbox = layer
        .try_bounding_box()
        .context("gerber has no drawable geometry")?;
    let (w_mm, h_mm) = (bbox.width() as f32, bbox.height() as f32);
    let t_layer = t0.elapsed();

    let longest = w_mm.max(h_mm).max(0.001);
    // Render close to the screen's native pitch so the preview is as crisp as the
    // real exposure; never exceed it (no extra detail beyond one LCD pixel), and
    // cap by max_px so a large board doesn't produce a huge PNG.
    let native = crate::goo::SCREEN_PX_PER_MM_X;
    let pitch = (max_px as f32 / longest).clamp(1.0, native);
    let opts = RenderOptions {
        margin_mm: 0.0,
        ..RenderOptions::square(pitch)
    };
    let (pm, info) = render_layer(&layer, &opts)?;
    let t_render = t0.elapsed();

    // The mask is black/white, so encode a 1-byte/px grayscale PNG with fast
    // compression — tiny-skia's encode_png (RGBA, default zlib level) spent ~1s
    // here; grayscale is 4× less data and Fast compression is ~10× quicker.
    let png = encode_gray_png_fast(&to_grayscale(&pm), info.px_w, info.px_h)?;
    let t_done = t0.elapsed();

    let summary = format!(
        "{} cmds, {:.0}x{:.0}mm @ {:.1}px/mm -> {}x{}px, {} KiB | parse {:.0?} layer {:.0?} render {:.0?} encode {:.0?} TOTAL {:.0?}",
        n_cmds, w_mm, h_mm, pitch, info.px_w, info.px_h, png.len() / 1024,
        t_parse, t_layer - t_parse, t_render - t_layer, t_done - t_render, t_done,
    );
    eprintln!("[render_preview] {summary}");
    Ok((png, info, summary))
}

/// Encode a row-major grayscale buffer as a PNG with fast compression. Far
/// quicker than tiny-skia's default RGBA encoder for big B/W masks.
fn encode_gray_png_fast(gray: &[u8], w: u32, h: u32) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, w, h);
        enc.set_color(png::ColorType::Grayscale);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        // Skip adaptive per-row filtering (a full extra pass over millions of
        // pixels); a B/W mask compresses fine without it.
        enc.set_filter(png::FilterType::NoFilter);
        let mut writer = enc.write_header().map_err(|e| anyhow!("png header: {e}"))?;
        writer
            .write_image_data(gray)
            .map_err(|e| anyhow!("png data: {e}"))?;
    }
    Ok(out)
}

/// Extract a row-major grayscale mask (one byte per pixel) from a rendered
/// Pixmap. The render is pure black/white and opaque, so premultiplied == straight
/// and the red channel alone carries the value (0 = UV off, 255 = UV on).
pub fn to_grayscale(pm: &Pixmap) -> Vec<u8> {
    pm.data().chunks_exact(4).map(|px| px[0]).collect()
}

/// Save a row-major grayscale buffer (one byte per pixel) as a PNG, expanding
/// each value to opaque RGBA. Used to preview the full-screen composed mask.
pub fn save_gray_png(path: &Path, w: u32, h: u32, gray: &[u8]) -> Result<()> {
    let mut pm = Pixmap::new(w, h).context("preview pixmap alloc failed")?;
    for (dst, &g) in pm.data_mut().chunks_exact_mut(4).zip(gray.iter()) {
        dst.copy_from_slice(&[g, g, g, 255]);
    }
    pm.save_png(path).map_err(|e| anyhow!("save png: {e}"))?;
    Ok(())
}

/// Human-readable summary of what a parsed Gerber contains, to scope rendering.
pub fn summarize(commands: &[Command]) -> String {
    use std::collections::BTreeMap;

    let mut category: BTreeMap<&str, usize> = BTreeMap::new();
    let mut aperture_defs: Vec<String> = Vec::new();
    let (mut d01, mut d02, mut d03) = (0usize, 0usize, 0usize);

    for cmd in commands {
        let dbg = format!("{cmd:?}");
        let cat = if dbg.contains("ApertureDefinition") {
            aperture_defs.push(dbg.clone());
            "ApertureDefinition"
        } else if dbg.contains("ApertureMacro") {
            aperture_defs.push(dbg.clone());
            "ApertureMacro"
        } else if dbg.contains("SelectAperture") {
            "SelectAperture"
        } else if dbg.contains("RegionMode") {
            "RegionMode(G36/G37)"
        } else if dbg.contains("Operation") {
            if dbg.contains("Interpolate") {
                d01 += 1;
            } else if dbg.contains("Move") {
                d02 += 1;
            } else if dbg.contains("Flash") {
                d03 += 1;
            }
            "Operation"
        } else {
            "other"
        };
        *category.entry(cat).or_insert(0) += 1;
    }

    let mut out = String::new();
    out.push_str(&format!("total commands: {}\n", commands.len()));
    for (k, v) in &category {
        out.push_str(&format!("  {k}: {v}\n"));
    }
    out.push_str(&format!("operations: D01={d01} D02={d02} D03={d03}\n"));
    out.push_str(&format!(
        "aperture/macro definitions ({}):\n",
        aperture_defs.len()
    ));
    for def in &aperture_defs {
        out.push_str(&format!("  {def}\n"));
    }
    out
}
