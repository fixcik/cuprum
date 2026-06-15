//! Layer polygon builders: parse a gerber (or take a parsed layer), tessellate
//! its primitives, union into clean shapes via `i_overlay`, and subtract drill
//! holes / mask openings. All entry points funnel through [`fill_polygons`].

use crate::{GerberLayer, GerberPrimitive};
use anyhow::Result;
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::overlay::FloatOverlay;

use super::tess::{circle, contours_for, contours_of, to_ccw, CIRCLE_SEGS};
use super::{Hole, Poly};

/// Compute clean filled polygons from raw gerber bytes and drill holes, for ANY
/// generic fill layer (copper, silk, paste, other). They all share the same
/// path: union the primitive contours, then subtract the drill holes (so holes
/// cut the silk, pour, etc.).
///
/// 1. Parse like [`crate::svg`] (`parse` → `GerberLayer::new` → `primitives()`).
/// 2. Convert every primitive to one or more solid contours (Add-only).
/// 3. Union all contours into clean, non-self-intersecting shapes.
/// 4. Subtract the drill holes.
///
/// Returns outer-ring + holes polygons ready to triangulate on the frontend.
#[tracing::instrument(skip_all, fields(holes = holes.len()))]
pub fn layer_polygons(bytes: &[u8], holes: &[Hole]) -> Result<Vec<Poly>> {
    // Shared cross-operation parse: metrics/mesh/SVG reuse one parsed layer.
    let layer = crate::gerber::parse_layer_cached(bytes)?;
    Ok(layer_polygons_from(&layer, holes))
}

/// Like [`layer_polygons`] but from an already-parsed layer — used by callers that
/// parse each layer once and share it across analyses (see `metrics`'s parse-once).
pub fn layer_polygons_from(layer: &GerberLayer, holes: &[Hole]) -> Vec<Poly> {
    let contours = contours_of(layer.primitives());
    fill_polygons(&contours, holes)
}

/// Backwards-compatible alias for the original copper-only entry point. Copper
/// is just a generic fill layer, so this forwards to [`layer_polygons`].
#[tracing::instrument(skip_all, fields(holes = holes.len()))]
pub fn copper_polygons(bytes: &[u8], holes: &[Hole]) -> Result<Vec<Poly>> {
    layer_polygons(bytes, holes)
}

/// Like [`layer_polygons`] but from FILL primitives only — flashes (Circle,
/// Rectangle, Polygon) and region fills (G36) — skipping routed strokes
/// (Line/Arc). The copper-WIDTH (neck) check runs on THIS set: a trace's width is
/// its aperture (measured via the conductor model), so unioning trace strokes and
/// cross-measuring their concave bends only produced artefacts. Genuine necks live
/// in zone fills, which this preserves.
#[tracing::instrument(skip_all, fields(holes = holes.len()))]
pub fn region_polygons(bytes: &[u8], holes: &[Hole]) -> Result<Vec<Poly>> {
    // Shared cross-operation parse: metrics/mesh/SVG reuse one parsed layer.
    let layer = crate::gerber::parse_layer_cached(bytes)?;
    Ok(region_polygons_from(&layer, holes))
}

/// Like [`region_polygons`] (FILL primitives only) but from an already-parsed layer.
pub fn region_polygons_from(layer: &GerberLayer, holes: &[Hole]) -> Vec<Poly> {
    let mut contours: Vec<Vec<[f64; 2]>> = Vec::new();
    for prim in layer.primitives() {
        if matches!(prim, GerberPrimitive::Line(_) | GerberPrimitive::Arc(_)) {
            continue;
        }
        contours_for(prim, &mut contours);
    }
    fill_polygons(&contours, holes)
}

/// Compute the soldermask geometry: the board region MINUS the mask openings.
///
/// The board outline (a set of CCW/CW rings — outer perimeter plus inner
/// cutouts) is stitched on the frontend from Edge_Cuts (see
/// `cuprum-ui/src/lib/boardOutline.ts`) and passed in as `outline_rings`. We do
/// NOT re-implement Edge_Cuts stitching here.
///
/// The mask gerber's primitives are the openings (where there is NO mask, e.g.
/// exposed pads). We build them as solid contours and subtract them from the
/// board, so the result is the green soldermask film with the pad openings cut
/// out — `difference(board_outline, openings)`.
///
/// Drill holes are subtracted too: a drilled bore removes ALL material at that
/// spot, so the mask film must be cut there as well — otherwise a tented via
/// (no opening) leaves the green film spanning the bore, and the hole never
/// "punches through" in the 3D view (copper + FR4 are drilled, the mask is not).
#[tracing::instrument(skip_all, fields(rings = outline_rings.len(), holes = holes.len()))]
pub fn mask_polygons(
    outline_rings: &[Vec<[f64; 2]>],
    mask_bytes: &[u8],
    holes: &[Hole],
) -> Result<Vec<Poly>> {
    let board: Vec<Vec<[f64; 2]>> = outline_rings
        .iter()
        .filter(|r| r.len() >= 3)
        .cloned()
        .collect();
    if board.is_empty() {
        return Ok(Vec::new());
    }

    // Shared cross-operation parse: metrics/mesh/SVG reuse one parsed layer.
    let layer = crate::gerber::parse_layer_cached(mask_bytes)?;
    // Normalize every opening contour to CCW before the difference. An opening
    // (e.g. a roundrect pad = rect + corner circles) is built from several
    // primitives of mixed winding; under NonZero they cancel to winding 0 at the
    // overlaps (pad corners), so that area isn't part of the clip and is NOT cut
    // out → the mask covers the pad corners (dark "bites"). All-CCW makes each
    // opening a solid clip that subtracts fully. (Same root cause as the copper
    // "mouse bites" — see fill_polygons.)
    let mut clip: Vec<Vec<[f64; 2]>> = contours_of(layer.primitives())
        .into_iter()
        .map(to_ccw)
        .collect();
    // Drill bores join the clip: both openings and drills are cut from the board.
    clip.extend(
        holes
            .iter()
            .filter(|h| h.d > 0.0)
            .map(|h| circle(h.x, h.y, h.d / 2.0, CIRCLE_SEGS)),
    );

    // No openings and no drills → the whole board is masked.
    let shapes = if clip.is_empty() {
        FloatOverlay::with_subj(&board).overlay(OverlayRule::Subject, FillRule::NonZero)
    } else {
        FloatOverlay::with_subj_and_clip(&board, &clip)
            .overlay(OverlayRule::Difference, FillRule::NonZero)
    };

    Ok(shapes_to_polys(shapes))
}

/// Build clean polygons from a set of (possibly overlapping / self-touching)
/// solid contours and a set of drill holes to subtract. Layer-agnostic so
/// other layers can reuse it.
#[tracing::instrument(skip_all, fields(contours = contours.len()))]
pub fn fill_polygons(contours: &[Vec<[f64; 2]>], holes: &[Hole]) -> Vec<Poly> {
    if contours.is_empty() {
        return Vec::new();
    }

    // Normalize every contour to CCW first. The stroke rectangles in
    // `push_stroke` get a direction-dependent winding (a rightward segment is CW,
    // a leftward one CCW); under `FillRule::NonZero` two opposite-wound rectangles
    // overlapping at a trace BEND cancel to winding 0 and leave a triangular notch
    // ("mouse bites"). Forcing all contours CCW makes overlaps accumulate winding
    // (>=1) so the whole covered area fills. (All contours are additive here —
    // the forked parsing core emits no clear-polarity — so there are no
    // intended winding-holes to preserve; drills are subtracted separately.)
    let subj: Vec<Vec<[f64; 2]>> = contours.iter().map(|c| to_ccw(c.clone())).collect();

    // Union all subject contours: resolves the self-touching pour and overlaps
    // into a set of clean shapes (each shape = outer contour + inner holes).
    let union = FloatOverlay::with_subj(&subj).overlay(OverlayRule::Subject, FillRule::NonZero);

    let shapes = if holes.is_empty() {
        union
    } else {
        let drills: Vec<Vec<[f64; 2]>> = holes
            .iter()
            .filter(|h| h.d > 0.0)
            .map(|h| circle(h.x, h.y, h.d / 2.0, CIRCLE_SEGS))
            .collect();
        if drills.is_empty() {
            union
        } else {
            FloatOverlay::with_subj_and_clip(&union, &drills)
                .overlay(OverlayRule::Difference, FillRule::NonZero)
        }
    };

    shapes_to_polys(shapes)
}

/// Convert i_overlay output shapes into our [`Poly`] DTO.
///
/// i_overlay shapes: `Vec<Shape>`, `Shape = Vec<Contour>`, `Contour = Vec<[f64;2]>`.
/// The first contour of each shape is its outer ring; the rest are holes.
pub fn shapes_to_polys(shapes: Vec<Vec<Vec<[f64; 2]>>>) -> Vec<Poly> {
    shapes
        .into_iter()
        .filter_map(|shape| {
            let mut rings = shape.into_iter();
            let outer = rings.next()?;
            if outer.len() < 3 {
                return None;
            }
            Some(Poly {
                outer: to_f32(outer),
                holes: rings.filter(|r| r.len() >= 3).map(to_f32).collect(),
            })
        })
        .collect()
}

fn to_f32(ring: Vec<[f64; 2]>) -> Vec<[f32; 2]> {
    ring.into_iter()
        .map(|[x, y]| [x as f32, y as f32])
        .collect()
}
