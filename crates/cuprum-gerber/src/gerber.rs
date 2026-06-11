//! Gerber (RS-274X) parsing and rasterization to an exposure mask.
//!
//! We reuse the forked (MIT/Apache) `crate::viewer` parsing core for the hard part —
//! parsing commands into geometry primitives (apertures, macros, regions,
//! polarity, coordinates). We own only the rasterizer: walk the primitives and
//! paint them into a `tiny-skia` Pixmap (white = UV on, black = UV off).

use crate::lock_recover;
use std::collections::HashMap;
use std::fs::File;
use std::io::BufReader;
use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use crate::gerber_types::Command;
use crate::{Exposure, GerberLayer, GerberPrimitive};
use anyhow::{anyhow, Context, Result};
use lru::LruCache;
use tiny_skia::{
    Color, FillRule, LineCap, LineJoin, Paint, PathBuilder, Pixmap, Rect, Stroke, Transform,
};

/// Parse a `.gbr` file into a flat list of Gerber commands.
#[tracing::instrument(skip_all, fields(path = %path.display()))]
pub fn parse_file(path: &Path) -> Result<Vec<Command>> {
    let file = File::open(path)?;
    let reader = BufReader::new(file);
    let doc =
        crate::gerber_parser::parse(reader).map_err(|(_doc, e)| anyhow!("parse error: {e:?}"))?;
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
    /// Clockwise rotation of the artwork on the exposure screen (0 / 90 / 180 / 270).
    ///
    /// This matches the Konva/panel-editor convention where positive angles are
    /// clockwise in screen Y-down space.  For 90°/270° the pixmap dimensions swap:
    /// the board's mm-height spans the screen X axis and mm-width spans screen Y.
    /// The anisotropic X/Y pixel pitch is applied AFTER the geometry rotation so
    /// the output is always scale-correct regardless of orientation.
    pub rotation_deg: u16,
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

    /// Square resolution with the given clockwise rotation.
    pub fn square_rotated(px_per_mm: f32, rotation_deg: u16) -> Self {
        Self {
            rotation_deg,
            ..Self::square(px_per_mm)
        }
    }
}

impl Default for RenderOptions {
    fn default() -> Self {
        // Default to the printer's native (anisotropic) pixel pitch so the mask
        // is exposure-ready: one output pixel == one LCD pixel.
        Self {
            px_per_mm_x: cuprum_goo::SCREEN_PX_PER_MM_X,
            px_per_mm_y: cuprum_goo::SCREEN_PX_PER_MM_Y,
            margin_mm: 1.0,
            mirror_x: false,
            invert: false,
            rotation_deg: 0,
        }
    }
}

/// Geometry of a rendered Gerber: the rasterized image size in pixels and the
/// real-world size of that image in millimeters (bounding box + 2×margin).
///
/// ## Coordinate conventions
///
/// Gerber world coordinates use Y-up (mathematical convention). The rasterizer
/// flips Y so that image row 0 sits at the **top** of the world bounding box.
/// Concretely:
///
/// - Image pixel (0, 0) top-left  → world (`min_x_mm`, `max_y_mm`)
/// - Image pixel (px_w-1, 0) top-right → world (`max_x_mm`, `max_y_mm`)
/// - Image pixel (0, px_h-1) bottom-left → world (`min_x_mm`, `min_y_mm`)
/// - Image pixel (px_w-1, px_h-1) bottom-right → world (`max_x_mm`, `min_y_mm`)
///
/// All four corners are exposed so callers that blit the mask onto a Y-down
/// screen can pick whichever pair they need without re-deriving it.
///
/// ## Rotation
///
/// When [`RenderOptions::rotation_deg`] is non-zero the mm corners describe the
/// **axis-aligned bounding box of the rotated artwork** (still in gerber Y-up
/// coords), not the original unrotated bbox.  The pixel-to-world mapping above
/// holds unchanged: pixel (0,0) is still the world point (`min_x_mm`, `max_y_mm`)
/// of that rotated bbox.  For 90°/270° the roles of the original width and height
/// are swapped (`width_mm = original_height_mm`, etc.).
#[derive(Clone, Copy, Debug)]
pub struct RenderInfo {
    pub px_w: u32,
    pub px_h: u32,
    pub width_mm: f32,
    pub height_mm: f32,
    /// World-space left edge (X minimum, margin-adjusted).  Corresponds to the
    /// left column of the raster image.
    pub min_x_mm: f32,
    /// World-space bottom edge (Y minimum in Gerber's Y-up coords,
    /// margin-adjusted).  Corresponds to the **bottom** row of the raster image
    /// (largest row index = `px_h - 1`).
    pub min_y_mm: f32,
    /// World-space right edge (X maximum, margin-adjusted).  Corresponds to the
    /// right column of the raster image.
    pub max_x_mm: f32,
    /// World-space top edge (Y maximum in Gerber's Y-up coords,
    /// margin-adjusted).  Corresponds to the **top** row of the raster image
    /// (row index 0).  This is the Y coordinate of pixel (0, 0).
    pub max_y_mm: f32,
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
    // Unrotated bbox (with margin), in gerber Y-up world coordinates.
    let min_x = bbox.min.x - margin;
    let min_y = bbox.min.y - margin;
    let max_x = bbox.max.x + margin;
    let max_y = bbox.max.y + margin;
    let w_mm = max_x - min_x;
    let h_mm = max_y - min_y;
    let cx_mm = (min_x + max_x) / 2.0;
    let cy_mm = (min_y + max_y) / 2.0;
    let sx = opts.px_per_mm_x as f64;
    let sy = opts.px_per_mm_y as f64;

    // Rotated bbox and pixmap dimensions.
    //
    // Rotation is clockwise on the exposure screen (matching the panel editor's
    // Konva convention where positive rotation_deg = CW in screen Y-down space).
    // In gerber Y-up math space this corresponds to a CCW rotation by the same
    // angle: rotating points by +rotation_deg degrees (CCW in Y-up) and then
    // applying the Y-flip makes the result appear rotated CW on screen.
    //
    // After rotating the original w_mm × h_mm rectangle about its centre, the
    // axis-aligned bounding box of the rotated shape is:
    //   - 0° / 180°  : same extents as unrotated (w_mm × h_mm)
    //   - 90° / 270° : extents swap (h_mm × w_mm)
    //
    // The rotated bbox is always centred on (cx_mm, cy_mm).
    let (rot_w_mm, rot_h_mm) = match opts.rotation_deg.wrapping_rem(360) {
        90 | 270 => (h_mm, w_mm),
        _ => (w_mm, h_mm),
    };
    let rot_min_x = cx_mm - rot_w_mm / 2.0;
    let rot_max_y = cy_mm + rot_h_mm / 2.0;
    let rot_min_y = cy_mm - rot_h_mm / 2.0;
    let rot_max_x = cx_mm + rot_w_mm / 2.0;

    let pw = ((rot_w_mm * sx).ceil() as u32).max(1);
    let ph = ((rot_h_mm * sy).ceil() as u32).max(1);
    let mut pm = Pixmap::new(pw, ph).context("failed to allocate pixmap (too large?)")?;
    pm.fill(Color::BLACK);

    // Build the mm → pixel transform.
    //
    // The final anisotropic scale + Y-flip + translate maps the rotated bbox to
    // pixel space: pixel (0,0) = world (rot_min_x, rot_max_y).
    //
    //   For mirror_x the X scale is negated so the right edge maps to column 0.
    //
    // When rotation_deg > 0, we pre-concat a rotate-about-centre in gerber Y-up
    // space BEFORE the scale/flip.  `pre_concat` applies the additional transform
    // FIRST on the point, then the scale/flip.  This implements:
    //
    //   pixel = scale_flip · rotate_about_centre · world_point
    //
    // tiny-skia `from_rotate(angle)` uses standard math convention (CCW positive),
    // which — combined with the Y-flip in the scale step — produces a CW rotation
    // on the exposure screen, matching the Konva panel editor.
    let base_tf = if opts.mirror_x {
        // Mirrored: X scale negated, origin shifts to right edge of rotated bbox.
        Transform::from_row(
            -sx as f32,
            0.0,
            0.0,
            -sy as f32,
            (sx * rot_max_x) as f32,
            (sy * rot_max_y) as f32,
        )
    } else {
        Transform::from_row(
            sx as f32,
            0.0,
            0.0,
            -sy as f32,
            (-sx * rot_min_x) as f32,
            (sy * rot_max_y) as f32,
        )
    };

    let tf = if opts.rotation_deg.is_multiple_of(360) {
        // Fast path: no rotation, identical to the original code path.
        base_tf
    } else {
        // Rotate the geometry about the unrotated bbox centre (gerber Y-up, CCW
        // positive = CW on screen after Y-flip) then apply the scale/flip above.
        base_tf.pre_concat(Transform::from_rotate_at(
            opts.rotation_deg as f32,
            cx_mm as f32,
            cy_mm as f32,
        ))
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
        // Report the axis-aligned bbox of what was actually drawn: the rotated
        // bbox in gerber Y-up coords.  For 0°/180° this equals the unrotated
        // bbox; for 90°/270° width and height (and min/max) reflect the swap.
        width_mm: rot_w_mm as f32,
        height_mm: rot_h_mm as f32,
        min_x_mm: rot_min_x as f32,
        min_y_mm: rot_min_y as f32,
        max_x_mm: rot_max_x as f32,
        max_y_mm: rot_max_y as f32,
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
#[tracing::instrument(skip_all, fields(max_px))]
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
    let native = cuprum_goo::SCREEN_PX_PER_MM_X;
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

// ---- Parsed-layer cache (memory only, cross-operation) ----
//
// On a cold design show the three operations (metrics / mesh / SVG) each parse
// the SAME gerber bytes into a `GerberLayer` — concurrently, so a large copper
// layer is parsed ~3× at once (wasted CPU + core contention). Each op caches its
// own *output* already, so this is a purely cold-path waste. This shared,
// content-keyed parse cache lets all three reuse one parse.
//
// Memory-only: `GerberLayer` is not `Serialize`/`DeserializeOwned`, so it can't go
// through the disk-backed single-flight engine; and it's ephemeral — the per-op
// *outputs* (svg/metrics/mesh artifacts) are what persist on disk. An `Arc` keeps
// cache hits cheap (cloning a parsed layer is expensive). Single-flight de-dups
// concurrent misses so a given layer is parsed once across all three ops.
//
// Lives here (not in `cache`) so the render paths (svg / geometry / mesh / dfm)
// depend on `gerber`, not back on `cache` — keeping the module DAG acyclic.
const PARSE_MEM_CAP: usize = 64;
fn parse_cache() -> &'static Mutex<LruCache<String, Arc<GerberLayer>>> {
    static C: OnceLock<Mutex<LruCache<String, Arc<GerberLayer>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(LruCache::new(NonZeroUsize::new(PARSE_MEM_CAP).unwrap())))
}
fn parse_inflight() -> &'static Mutex<HashMap<String, Arc<Mutex<()>>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The single Gerber parse site: bytes → `GerberLayer` (same triple every path
/// used inline before — `parse` → `into_commands` → `GerberLayer::new`). Not
/// cached; `parse_layer_cached` wraps this with memoization.
fn parse_layer(bytes: &[u8]) -> anyhow::Result<GerberLayer> {
    let reader = std::io::BufReader::new(std::io::Cursor::new(bytes));
    let doc = crate::gerber_parser::parse(reader)
        .map_err(|(_doc, e)| anyhow::anyhow!("parse error: {e:?}"))?;
    Ok(GerberLayer::new(doc.into_commands()))
}

/// Parse raw Gerber bytes into a shared `GerberLayer`, memoized in-process by
/// content hash with single-flight de-dup. The metrics, mesh and SVG paths all go
/// through this, so a given layer is parsed once between them instead of ~3×
/// concurrently on a cold design show. Memory-only (see the section comment).
/// Honors `diskcache::cache_disabled()` (then parses straight through, no caching).
///
/// Lock discipline: the `inflight` registry lock is released before taking the
/// per-key `flight` lock; the LRU is locked only briefly, never across `parse_layer()`.
pub fn parse_layer_cached(bytes: &[u8]) -> anyhow::Result<Arc<GerberLayer>> {
    if cuprum_diskcache::diskcache::cache_disabled() {
        return Ok(Arc::new(parse_layer(bytes)?));
    }
    let key = cuprum_diskcache::diskcache::key_for(&[bytes]);
    if let Some(v) = lock_recover(parse_cache()).get(&key) {
        return Ok(v.clone());
    }
    let flight = {
        let mut reg = lock_recover(parse_inflight());
        reg.entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _flight = lock_recover(&flight);
    // Re-check: the winner may have populated the LRU while we waited.
    if let Some(v) = lock_recover(parse_cache()).get(&key) {
        return Ok(v.clone());
    }
    let drop_inflight = || {
        let mut reg = lock_recover(parse_inflight());
        if let Some(existing) = reg.get(&key) {
            if Arc::ptr_eq(existing, &flight) {
                reg.remove(&key);
            }
        }
    };
    let layer = match parse_layer(bytes) {
        Ok(l) => Arc::new(l),
        Err(e) => {
            drop_inflight();
            return Err(e);
        }
    };
    lock_recover(parse_cache()).put(key.clone(), layer.clone());
    drop_inflight();
    Ok(layer)
}

#[cfg(test)]
mod parse_cache_tests {
    use super::*;

    #[test]
    fn parse_layer_cached_dedups_under_concurrency_and_memoizes() {
        // Unique aperture diameter → a guaranteed-cold key regardless of test order.
        const UNIQ: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.111*%\nD10*\nX0Y0D03*\nM02*\n";
        let key = cuprum_diskcache::diskcache::key_for(&[UNIQ]);
        lock_recover(parse_cache()).pop(&key);
        lock_recover(parse_inflight()).remove(&key);

        // Concurrent cold misses → single-flight → exactly one parse, shared by all
        // callers. If any thread parsed independently its Arc would not be ptr-equal.
        // A barrier releases all threads at once so they actually race on the per-key
        // flight lock (without it they'd serialize on the initial LRU check and never
        // exercise the single-flight window).
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let mut handles = vec![];
        for _ in 0..8 {
            let b = Arc::clone(&barrier);
            handles.push(std::thread::spawn(move || {
                b.wait();
                parse_layer_cached(UNIQ).expect("parse ok")
            }));
        }
        let layers: Vec<_> = handles
            .into_iter()
            .map(|h| h.join().expect("thread ok"))
            .collect();
        let first = layers[0].clone();
        for l in &layers {
            assert!(
                Arc::ptr_eq(l, &first),
                "all concurrent callers share one parsed Arc (parsed exactly once)"
            );
        }
        // A later call hits the cache and returns the same instance.
        let again = parse_layer_cached(UNIQ).expect("hit ok");
        assert!(
            Arc::ptr_eq(&again, &first),
            "repeat call returns the cached Arc, not a fresh parse"
        );
    }

    #[test]
    fn parse_layer_cached_distinct_bytes_are_not_conflated() {
        const A: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,1.222*%\nD10*\nX0Y0D03*\nM02*\n";
        const B: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.333*%\nD10*\nX0Y0D03*\nM02*\n";
        let a = parse_layer_cached(A).expect("ok");
        let b = parse_layer_cached(B).expect("ok");
        assert!(
            !Arc::ptr_eq(&a, &b),
            "distinct gerbers map to distinct cache entries"
        );
    }
}

#[cfg(test)]
mod render_info_bbox_tests {
    use super::*;

    // A 2mm-diameter circle (radius 1mm) flashed at world (3.0, 2.0) mm.
    // With FSLAX24Y24 the integer coordinate unit is 10^-4 mm, so:
    //   X=3.0mm  → X30000
    //   Y=2.0mm  → Y20000
    // The copper bbox will be [2.0, 4.0] × [1.0, 3.0] mm (center ± radius).
    //
    // Flash at non-zero position to verify that min_x/min_y/max_x/max_y are not
    // all near zero (catching an accidental "use origin" bug).
    const CIRCLE_AT_3_2: &[u8] =
        b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,2.0*%\nD10*\nX30000Y20000D03*\nM02*\n";

    fn approx_eq(a: f32, b: f32) -> bool {
        (a - b).abs() < 0.01
    }

    /// RenderInfo mm corners match the known artwork bbox (no margin).
    #[test]
    fn render_info_bbox_no_margin_circle_at_3_2() {
        let cmds = parse_file_bytes(CIRCLE_AT_3_2).expect("parse ok");
        let opts = RenderOptions {
            margin_mm: 0.0,
            ..RenderOptions::square(10.0)
        };
        let (_, info) = render_with_info(cmds, &opts).expect("render ok");

        // Copper bbox: x ∈ [2.0, 4.0], y ∈ [1.0, 3.0]  (center=3,2; radius=1)
        assert!(
            approx_eq(info.min_x_mm, 2.0),
            "min_x_mm should be ~2.0, got {}",
            info.min_x_mm
        );
        assert!(
            approx_eq(info.min_y_mm, 1.0),
            "min_y_mm should be ~1.0, got {}",
            info.min_y_mm
        );
        assert!(
            approx_eq(info.max_x_mm, 4.0),
            "max_x_mm should be ~4.0, got {}",
            info.max_x_mm
        );
        assert!(
            approx_eq(info.max_y_mm, 3.0),
            "max_y_mm should be ~3.0, got {}",
            info.max_y_mm
        );
        // width/height consistency
        assert!(
            approx_eq(info.width_mm, info.max_x_mm - info.min_x_mm),
            "width_mm = max_x - min_x"
        );
        assert!(
            approx_eq(info.height_mm, info.max_y_mm - info.min_y_mm),
            "height_mm = max_y - min_y"
        );
    }

    /// With a margin the bbox corners are shifted outward by the margin amount.
    #[test]
    fn render_info_bbox_with_margin() {
        let cmds = parse_file_bytes(CIRCLE_AT_3_2).expect("parse ok");
        let margin = 1.5_f32;
        let opts = RenderOptions {
            margin_mm: margin,
            ..RenderOptions::square(10.0)
        };
        let (_, info) = render_with_info(cmds, &opts).expect("render ok");

        // With margin the corners expand by `margin` in every direction.
        assert!(
            approx_eq(info.min_x_mm, 2.0 - margin),
            "min_x with margin: got {}",
            info.min_x_mm
        );
        assert!(
            approx_eq(info.min_y_mm, 1.0 - margin),
            "min_y with margin: got {}",
            info.min_y_mm
        );
        assert!(
            approx_eq(info.max_x_mm, 4.0 + margin),
            "max_x with margin: got {}",
            info.max_x_mm
        );
        assert!(
            approx_eq(info.max_y_mm, 3.0 + margin),
            "max_y with margin: got {}",
            info.max_y_mm
        );
    }

    /// Pixel (0,0) corresponds to world (min_x_mm, max_y_mm): the raster Y-flip
    /// means the image top row maps to the highest world Y coordinate.
    #[test]
    fn render_info_pixel_origin_is_top_left_world_max_y() {
        let cmds = parse_file_bytes(CIRCLE_AT_3_2).expect("parse ok");
        let opts = RenderOptions {
            margin_mm: 0.0,
            ..RenderOptions::square(10.0)
        };
        let (_, info) = render_with_info(cmds, &opts).expect("render ok");

        // top-left pixel → (min_x, max_y) in world coords.  Verify the relationship
        // is self-consistent: height = max_y - min_y ≈ px_h / px_per_mm.
        let expected_h = (info.px_h as f32) / 10.0;
        let actual_h = info.max_y_mm - info.min_y_mm;
        assert!(
            (actual_h - expected_h).abs() < 0.15,
            "height consistent with pixel count: expected ~{expected_h:.3}, got {actual_h:.3}"
        );
    }

    /// Helper: parse raw Gerber bytes into commands (same as parse_file but from bytes).
    fn parse_file_bytes(bytes: &[u8]) -> anyhow::Result<Vec<crate::gerber_types::Command>> {
        use crate::gerber_parser;
        let reader = std::io::BufReader::new(std::io::Cursor::new(bytes));
        let doc =
            gerber_parser::parse(reader).map_err(|(_, e)| anyhow::anyhow!("parse error: {e:?}"))?;
        Ok(doc.into_commands())
    }
}

// ---- Rotation tests ----------------------------------------------------------------
//
// Fixture: an asymmetric board with most ink in the lower-left quadrant.
//
//   Big pad  : 2mm-diameter circle at world (1.0, 1.0)  — carries almost all lit pixels
//   Tiny pad : 0.01mm-diameter circle at world (5.0, 3.0) — defines far bbox corner
//
// Combined bbox (no margin): x ∈ [0.0, 5.005], y ∈ [0.0, 3.005]
//   w_mm ≈ 5.005 mm,  h_mm ≈ 3.005 mm
//   centre cx ≈ 2.5025 mm, cy ≈ 1.5025 mm
//
// At px_per_mm = 10 (square, for integer-friendly arithmetic):
//
//   0°  : pw = ceil(5.005 * 10) = 51, ph = ceil(3.005 * 10) = 31
//         big-pad pixel centroid ≈ (10, 20)  — left half, bottom half
//
//   90° : pw = ceil(3.005 * 10) = 31, ph = ceil(5.005 * 10) = 51  ← extents SWAPPED
//         geometry rotated +90° CCW in Y-up (= CW on screen after Y-flip)
//         big-pad pixel centroid ≈ (20, 40)  — right half, bottom half
//
//  180° : pw = 51, ph = 31  (same extents as 0°)
//         big-pad pixel centroid ≈ (40, 10)  — right half, top half
//
//  270° : pw = 31, ph = 51  (same extents as 90°)
//         geometry rotated +270° CCW in Y-up (= 270° CW on screen)
//         big-pad pixel centroid ≈ (10, 10)  — left half, top half
//
// The centroid progression 0°→90°→180°→270° traces bottom-left → bottom-right →
// top-right → top-left, which is clockwise on a Y-down screen.  This locks the
// rotation direction to match the Konva panel editor convention.
#[cfg(test)]
mod rotation_tests {
    use super::*;

    // FSLAX24Y24: coordinate unit = 10^-4 mm (X10000 = 1.0 mm).
    // Two pads:
    //   aperture D10 = 2.0mm circle → big pad at (1.0, 1.0)
    //   aperture D11 = 0.01mm circle → tiny anchor at (5.0, 3.0)
    const ASYMMETRIC_BOARD: &[u8] = b"\
%FSLAX24Y24*%\n\
%MOMM*%\n\
%ADD10C,2.0*%\n\
%ADD11C,0.01*%\n\
D10*\n\
X10000Y10000D03*\n\
D11*\n\
X50000Y30000D03*\n\
M02*\n";

    // px/mm used in all rotation tests (square, integer-friendly).
    const PPM: f32 = 10.0;

    fn parse(bytes: &[u8]) -> Vec<crate::gerber_types::Command> {
        use crate::gerber_parser;
        let reader = std::io::BufReader::new(std::io::Cursor::new(bytes));
        let doc = gerber_parser::parse(reader)
            .map_err(|(_, e)| format!("parse error: {e:?}"))
            .expect("parse ok");
        doc.into_commands()
    }

    fn opts(rotation_deg: u16) -> RenderOptions {
        RenderOptions {
            px_per_mm_x: PPM,
            px_per_mm_y: PPM,
            margin_mm: 0.0,
            mirror_x: false,
            invert: false,
            rotation_deg,
        }
    }

    /// Pixel centroid of all lit (non-zero) pixels in a rendered Pixmap.
    /// Returns (col_centroid, row_centroid) as f32 to allow fractional values.
    fn lit_centroid(pm: &Pixmap) -> (f32, f32) {
        let mut sum_x = 0u64;
        let mut sum_y = 0u64;
        let mut count = 0u64;
        for row in 0..pm.height() {
            for col in 0..pm.width() {
                // RGBA premultiplied; red channel = intensity for a pure white mask.
                let idx = (row * pm.width() + col) as usize * 4;
                let val = pm.data()[idx]; // red channel (255 = UV on)
                if val > 0 {
                    sum_x += col as u64 * val as u64;
                    sum_y += row as u64 * val as u64;
                    count += val as u64;
                }
            }
        }
        assert!(count > 0, "no lit pixels — geometry did not render");
        (sum_x as f32 / count as f32, sum_y as f32 / count as f32)
    }

    // ── test 1: 90°/270° swap pixmap extents ──────────────────────────────────

    /// A 90° rotation must swap the pixmap dimensions (rotated width = original
    /// height scaled by X pitch; rotated height = original width scaled by Y pitch).
    /// 0° and 90° use the same square pitch here so the swap is pixel-exact.
    #[test]
    fn render_rotated_90_swaps_pixel_extents() {
        let (pm0, info0) = render_with_info(parse(ASYMMETRIC_BOARD), &opts(0)).unwrap();
        let (pm90, info90) = render_with_info(parse(ASYMMETRIC_BOARD), &opts(90)).unwrap();

        // 0°: w≈5.005mm, h≈3.005mm → pw=51, ph=31
        assert_eq!(pm0.width(), 51, "0° pw");
        assert_eq!(pm0.height(), 31, "0° ph");
        assert_eq!(info0.px_w, 51);
        assert_eq!(info0.px_h, 31);

        // 90°: extents swap → pw=31, ph=51
        assert_eq!(pm90.width(), 31, "90° pw (was ph at 0°)");
        assert_eq!(pm90.height(), 51, "90° ph (was pw at 0°)");
        assert_eq!(info90.px_w, 31);
        assert_eq!(info90.px_h, 51);

        // mm extents also swap
        assert!(
            (info0.width_mm - info90.height_mm).abs() < 0.01,
            "width/height swap in mm"
        );
        assert!(
            (info0.height_mm - info90.width_mm).abs() < 0.01,
            "height/width swap in mm"
        );
    }

    // ── test 2: 0° and 180° have identical pixmap size ────────────────────────

    /// Rotating by 180° does not swap extents: the pixmap size equals the 0° size.
    #[test]
    fn render_0_and_180_unchanged_extents() {
        let (pm0, _) = render_with_info(parse(ASYMMETRIC_BOARD), &opts(0)).unwrap();
        let (pm180, _) = render_with_info(parse(ASYMMETRIC_BOARD), &opts(180)).unwrap();

        assert_eq!(pm0.width(), pm180.width(), "180° pw must equal 0° pw");
        assert_eq!(pm0.height(), pm180.height(), "180° ph must equal 0° ph");

        // 180° is not a transpose: the two pixmaps must differ at lit pixels.
        let data0 = pm0.data();
        let data180 = pm180.data();
        let any_diff = data0
            .chunks_exact(4)
            .zip(data180.chunks_exact(4))
            .any(|(a, b)| a[0] != b[0]);
        assert!(
            any_diff,
            "0° and 180° must produce different rasters (180° ≠ transpose)"
        );
    }

    // ── test 3: clockwise rotation direction matches Konva / panel editor ──────

    /// An asymmetric feature (big pad in the board's lower-left region) must move
    /// to predictable quadrants as the rotation increases in 90° CW steps on screen.
    ///
    /// Expected centroid quadrant (measured from pixmap centre):
    ///   0°  → left half,  bottom half   (pad started at lower-left)
    ///   90° → right half, bottom half   (CW 90° on screen: lower-left → lower-right)
    ///  180° → right half, top half      (CW 180°: lower-left → upper-right)
    ///  270° → left half,  top half      (CW 270°: lower-left → upper-left)
    ///
    /// This locks the rotation direction to match the Konva panel editor where
    /// `rotation = N` means N degrees clockwise in screen Y-down space.
    #[test]
    fn render_rotation_direction_matches_clockwise() {
        for (deg, expect_right_half, expect_bottom_half, label) in [
            (0u16, false, true, "0°"),
            (90u16, true, true, "90°"),
            (180u16, true, false, "180°"),
            (270u16, false, false, "270°"),
        ] {
            let (pm, _) = render_with_info(parse(ASYMMETRIC_BOARD), &opts(deg)).unwrap();
            let (cx, cy) = lit_centroid(&pm);
            let mid_x = pm.width() as f32 / 2.0;
            let mid_y = pm.height() as f32 / 2.0;

            let in_right = cx > mid_x;
            let in_bottom = cy > mid_y;

            assert_eq!(
                in_right,
                expect_right_half,
                "{label}: centroid col {cx:.1} vs mid {mid_x:.1} — expected {} half",
                if expect_right_half { "right" } else { "left" }
            );
            assert_eq!(
                in_bottom,
                expect_bottom_half,
                "{label}: centroid row {cy:.1} vs mid {mid_y:.1} — expected {} half",
                if expect_bottom_half { "bottom" } else { "top" }
            );
        }
    }
}
