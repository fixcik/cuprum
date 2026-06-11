//! Compose one or more Gerber placements onto the full exposure screen.
//!
//! This is the bridge between rendering (per-file masks) and the `.goo` encoder:
//! it blits every placement into a single 15120×6230 buffer, applies the global
//! emulsion-down mirror / resist inversion, and the printer's 180° orientation
//! correction. The result is ready for [`goo::single_layer_exposure`].
//!
//! Designed for the layout editor: today the UI/CLI pass a single placement, but
//! the list-based API extends to many copies on one board without changing shape.
//!
//! # Rotation support (0 / 90 / 180 / 270°)
//!
//! Each [`Placement`] carries a `rotation_deg` that is passed to the mask
//! renderer so the rasterised copper is already rotated before blitting.
//! The placement offsets are computed by [`resolve_panel_placements`] using
//! rotated bounding boxes for both the copper mask and the board outline; see
//! [`rotate_bbox_about_centre`] for the centre-pivot math.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use rayon::prelude::*;

use crate::cache::{self, Mask};
use crate::goo::{self, SCREEN_H, SCREEN_W};

/// One Gerber instance positioned on the screen. `off_x`/`off_y` are the
/// top-left of the rendered mask in screen pixels. `rotation_deg` (0/90/180/270)
/// selects the clockwise rotation that was applied when the mask was rasterised;
/// it must agree with the rotated bounding boxes used to compute the offsets.
#[derive(Clone, Debug)]
pub struct Placement {
    pub path: PathBuf,
    pub off_x: i32,
    pub off_y: i32,
    pub rotation_deg: u16,
}

/// One placed board instance with its resolved artwork path, for panel composition.
/// `origin_mm` is the board outline bbox minimum corner in the mask's Gerber coordinate
/// space. `x_mm`/`y_mm` is the instance top-left position in panel space (mm).
#[derive(Clone, Debug)]
pub struct PanelInstanceArt {
    /// Path to the Gerber copper layer to expose (not read by this function).
    pub mask_path: PathBuf,
    /// Board outline origin (bbox min corner) in the mask's Gerber coords (mm).
    /// For rotated instances this is the origin of the **rotated** outline bbox
    /// (see [`rotate_bbox_about_centre`]).
    pub origin_mm: (f32, f32),
    /// Instance top-left X position in panel space (mm).
    pub x_mm: f32,
    /// Instance top-left Y position in panel space (mm).
    pub y_mm: f32,
    /// Clockwise rotation in degrees (0, 90, 180, 270).
    pub rotation_deg: u16,
}

/// Resolve a panel of placed board instances into screen-pixel [`Placement`]s.
///
/// Centers the panel rectangle on the physical exposure screen and converts each
/// instance position (panel-space mm + Gerber origin offset) into the integer pixel
/// offset that [`compose_layout`] expects. No file IO is performed.
///
/// `panel_w_mm` / `panel_h_mm` are the panel bounding box dimensions in mm.
/// The panel is centered on the screen: any leftover margin is split equally on
/// each side.
///
/// # Rotation
/// All four rotations (0/90/180/270°) are supported.  Callers are responsible for
/// passing **rotated** `origin_mm` values (see [`rotate_bbox_about_centre`]) so
/// that the offset formula places the rotated mask at the correct screen position.
///
/// # Errors
/// Returns an error if the panel is larger than the exposure screen in either
/// dimension — it physically can't be exposed in a single pass.
pub fn panel_placements(
    panel_w_mm: f32,
    panel_h_mm: f32,
    instances: &[PanelInstanceArt],
) -> Result<Vec<Placement>> {
    use crate::goo::{SCREEN_PX_PER_MM_X, SCREEN_PX_PER_MM_Y, SCREEN_X_MM, SCREEN_Y_MM};

    if panel_w_mm > SCREEN_X_MM || panel_h_mm > SCREEN_Y_MM {
        anyhow::bail!(
            "panel ({:.2} × {:.2} mm) exceeds exposure screen ({:.2} × {:.2} mm)",
            panel_w_mm,
            panel_h_mm,
            SCREEN_X_MM,
            SCREEN_Y_MM
        );
    }

    let panel_off_x = (SCREEN_X_MM - panel_w_mm) / 2.0;
    let panel_off_y = (SCREEN_Y_MM - panel_h_mm) / 2.0;

    let placements = instances
        .iter()
        .map(|inst| {
            let off_x =
                ((panel_off_x + inst.x_mm - inst.origin_mm.0) * SCREEN_PX_PER_MM_X).round() as i32;
            let off_y =
                ((panel_off_y + inst.y_mm - inst.origin_mm.1) * SCREEN_PX_PER_MM_Y).round() as i32;

            Placement {
                path: inst.mask_path.clone(),
                off_x,
                off_y,
                rotation_deg: inst.rotation_deg,
            }
        })
        .collect();

    Ok(placements)
}

/// Rotate a bounding box about the centre of a rectangle in Gerber Y-up coords.
///
/// This is the special case of [`rotate_bbox_about_point`] where the pivot is the
/// rectangle's own centre, so the rotated AABB stays centred on the same point.
/// Use it for the **board outline** (a rotated instance pivots about the outline
/// centre, so the outline rotates about its own centre).  For the **copper mask**,
/// whose centre generally differs from the outline centre, use
/// [`rotate_bbox_about_point`] with `pivot = outline centre` instead — otherwise
/// the copper-to-outline registration shifts by the inter-centre offset at 90/270.
///
/// # Arguments
/// * `origin` — bbox minimum corner `(min_x, min_y)` in Gerber Y-up mm coords.
/// * `size`   — bbox dimensions `(width, height)` in mm.
/// * `deg`    — clockwise rotation on the exposure screen (0 / 90 / 180 / 270).
///   Maps to a counter-clockwise rotation of the same angle in Gerber Y-up space
///   (Y-flip inverts the sense).  0°/180° leave extents unchanged; 90°/270° swap
///   width and height.
///
/// # Returns
/// `(rotated_origin, rotated_size)` — the minimum corner and size of the
/// axis-aligned bbox of the rotated rectangle, with the same centre as the input.
pub fn rotate_bbox_about_centre(
    origin: (f32, f32),
    size: (f32, f32),
    deg: u16,
) -> ((f32, f32), (f32, f32)) {
    let pivot = (origin.0 + size.0 / 2.0, origin.1 + size.1 / 2.0);
    rotate_bbox_about_point(origin, size, pivot, deg)
}

/// Rotate an axis-aligned bbox about an **arbitrary pivot** and return the AABB of
/// the result, in Gerber Y-up mm coords.
///
/// A rotated board instance is a rigid rotation of {copper + outline} about a
/// single pivot — the board (outline) centre, matching the panel editor's
/// `InstanceLayer` group pivot.  The copper's bbox centre generally differs from
/// the outline centre, so the copper bbox must rotate about the *outline* centre,
/// not its own.  This helper computes that: pass the unrotated copper bbox and
/// `pivot = outline centre`.
///
/// # Arguments
/// * `origin` — bbox minimum corner `(min_x, min_y)` in Gerber Y-up mm coords.
/// * `size`   — bbox dimensions `(width, height)` in mm.
/// * `pivot`  — rotation pivot in Gerber Y-up mm coords.
/// * `deg`    — clockwise rotation on the exposure screen (0 / 90 / 180 / 270).
///   In Gerber Y-up space this is a counter-clockwise rotation by the same angle
///   (the raster Y-flip turns it into the CW screen rotation `gerber.rs` renders),
///   so the sign matches `native_mask(path, deg)`.
///
/// # Returns
/// `(rotated_origin, rotated_size)` — min corner + size of the rotated bbox's AABB.
/// The size is pivot-invariant and equals `native_mask(path, deg)`'s pixmap size
/// (extents swap for 90/270); only the position depends on the pivot.
///
/// # Geometry
/// Each corner `(x, y)` maps via CCW-by-θ about `(px, py)` in Y-up:
/// ```text
/// x' = px + (x−px)·cosθ − (y−py)·sinθ
/// y' = py + (x−px)·sinθ + (y−py)·cosθ
/// ```
/// For the four right angles this reduces to integer-exact swaps/negations, so no
/// trig is needed and the result is f32-exact for axis-aligned inputs.
pub fn rotate_bbox_about_point(
    origin: (f32, f32),
    size: (f32, f32),
    pivot: (f32, f32),
    deg: u16,
) -> ((f32, f32), (f32, f32)) {
    let (ox, oy) = origin;
    let (w, h) = size;
    let (px, py) = pivot;
    let corners = [
        (ox, oy),
        (ox + w, oy),
        (ox, oy + h),
        (ox + w, oy + h),
    ];
    // CCW rotation by `deg` about (px, py) in Y-up; exact for the four right angles.
    let rot = |(x, y): (f32, f32)| -> (f32, f32) {
        let (dx, dy) = (x - px, y - py);
        let (rx, ry) = match deg.wrapping_rem(360) {
            90 => (-dy, dx),
            180 => (-dx, -dy),
            270 => (dy, -dx),
            _ => (dx, dy),
        };
        (px + rx, py + ry)
    };
    let mut min_x = f32::INFINITY;
    let mut min_y = f32::INFINITY;
    let mut max_x = f32::NEG_INFINITY;
    let mut max_y = f32::NEG_INFINITY;
    for c in corners {
        let (rx, ry) = rot(c);
        min_x = min_x.min(rx);
        min_y = min_y.min(ry);
        max_x = max_x.max(rx);
        max_y = max_y.max(ry);
    }
    ((min_x, min_y), (max_x - min_x, max_y - min_y))
}

/// Input for [`resolve_panel_placements`]: one board instance with enough
/// geometry to correctly align the copper mask to the board outline corner.
///
/// For rotated instances (90°/270°) the caller must pre-rotate the bboxes about
/// the **shared instance pivot = outline centre**:
/// * `board_origin_mm`/`board_size_mm` via [`rotate_bbox_about_centre`] (the
///   outline's own centre IS the pivot);
/// * `mask_bbox_mm` via [`rotate_bbox_about_point`] with `pivot = outline centre`
///   (the copper's own centre generally differs, so it must NOT use its own).
#[derive(Clone, Debug)]
pub struct InstancePlacementInput {
    /// Path to the copper Gerber layer (not read here — passed through to [`Placement`]).
    pub mask_path: PathBuf,
    /// Copper mask bounding box in Gerber world coords (Y-up).
    /// Fields: `(min_x_mm, min_y_mm, max_x_mm, max_y_mm)`.
    /// For rotated instances this is the bbox of the copper rotated **about the
    /// outline centre** (its size equals `native_mask(path, rotation)`'s size).
    pub mask_bbox_mm: (f32, f32, f32, f32),
    /// Board outline bbox MIN corner (bottom-left, Gerber Y-up), from board metrics.
    /// For rotated instances this is the MIN corner of the **rotated** outline bbox.
    pub board_origin_mm: (f32, f32),
    /// Board outline size in mm (`width, height`), from board metrics.
    /// For rotated instances this is the size of the **rotated** outline bbox.
    pub board_size_mm: (f32, f32),
    /// Instance top-left position in panel space (mm, Y-down, origin top-left).
    pub inst_x_mm: f32,
    /// Instance top-left position in panel space (mm, Y-down, origin top-left).
    pub inst_y_mm: f32,
    /// Clockwise rotation in degrees (0, 90, 180, 270).
    pub rotation_deg: u16,
}

/// Resolve a panel of board instances into screen-pixel [`Placement`]s, correctly
/// aligning each copper mask so the board outline corner lands at the instance
/// position in panel space.
///
/// # Coordinate conventions
///
/// * Gerber / mask world: Y-up, origin somewhere in world space.
/// * Panel space: Y-down, origin top-left.
/// * The board outline's **top-left corner in panel space** corresponds to
///   `(inst_x_mm, inst_y_mm)` — the same convention the drill planner uses when
///   mapping board-local holes into panel space (`projectHoleToPanel`).
///
/// The copper mask's top-left pixel (`px[0]`) sits at world `(mask_min_x, mask_max_y)`
/// (raster row 0 = world Y-maximum = gerber top edge).  To land that pixel at the
/// correct screen position the function computes the `origin_mm` that
/// [`panel_placements`] expects:
///
/// ```text
/// origin_mm.x = board_origin_x  − mask_min_x
/// origin_mm.y = mask_max_y      − (board_origin_y + board_h)
/// ```
///
/// The X term shifts for any copper/outline horizontal offset.  The Y term
/// applies the Y-flip: in Gerber Y-up the board outline top edge is at
/// `board_origin_y + board_h`; subtracting `mask_max_y` from that top edge gives
/// the downward displacement in panel Y-down.
///
/// # Rotation
///
/// For instances with `rotation_deg` ≠ 0, callers must pre-rotate the bboxes about
/// the **shared instance pivot = outline centre**: the outline via
/// [`rotate_bbox_about_centre`] and the copper via [`rotate_bbox_about_point`]
/// (pivot = outline centre).  The formula above then works unchanged: it sees the
/// already-rotated bbox corners and computes the correct off values for the rotated
/// copper mask.  See [`InstancePlacementInput`] for why the copper must NOT rotate
/// about its own centre.
///
/// # Errors
/// Returns an error if the panel is larger than the exposure screen (same as
/// [`panel_placements`]).
pub fn resolve_panel_placements(
    panel_w_mm: f32,
    panel_h_mm: f32,
    items: &[InstancePlacementInput],
) -> Result<Vec<Placement>> {
    let instances: Vec<PanelInstanceArt> = items
        .iter()
        .map(|item| {
            let (mask_min_x, _mask_min_y, _mask_max_x, mask_max_y) = item.mask_bbox_mm;
            let (board_origin_x, board_origin_y) = item.board_origin_mm;
            let (_board_w, board_h) = item.board_size_mm;

            // origin_mm is passed to panel_placements which computes:
            //   off_x = (panel_off_x + inst_x - origin_mm.0) * px_per_mm_x
            //   off_y = (panel_off_y + inst_y - origin_mm.1) * px_per_mm_y
            //
            // We want the mask top-left pixel (world x=mask_min_x, world y=mask_max_y)
            // to appear at panel position:
            //   px = inst_x + (mask_min_x - board_origin_x)   [board-local X offset]
            //   py = inst_y + (board_h - (mask_max_y - board_origin_y))  [Y-flipped]
            //
            // Substituting into the off formula and solving for origin_mm:
            //   origin_mm.0 = board_origin_x - mask_min_x
            //   origin_mm.1 = mask_max_y - (board_origin_y + board_h)
            let origin_x = board_origin_x - mask_min_x;
            let origin_y = mask_max_y - (board_origin_y + board_h);

            PanelInstanceArt {
                mask_path: item.mask_path.clone(),
                origin_mm: (origin_x, origin_y),
                x_mm: item.inst_x_mm,
                y_mm: item.inst_y_mm,
                rotation_deg: item.rotation_deg,
            }
        })
        .collect();

    panel_placements(panel_w_mm, panel_h_mm, &instances)
}

/// Render + composite a layout into a full-screen exposure mask (row-major
/// grayscale, `SCREEN_W * SCREEN_H` bytes, 0 = UV off / 255 = on).
///
/// `mirror` flips the whole sheet horizontally (emulsion-down contact); `invert`
/// swaps lit/dark (positive vs negative resist). `screen_rotate` applies the
/// printer's native 180° orientation (leave true unless debugging).
#[tracing::instrument(skip_all, fields(placements = placements.len(), mirror, invert))]
pub fn compose_layout(
    placements: &[Placement],
    mirror: bool,
    invert: bool,
    screen_rotate: bool,
) -> Result<Vec<u8>> {
    let mut screen = vec![0u8; SCREEN_W as usize * SCREEN_H as usize];

    // Resolve each UNIQUE (file, rotation) pair's native mask once (auto-arrange
    // spawns many copies of the same file at the same rotation), in parallel,
    // through the cache — so repeat exposes and reloads reuse the raster.
    let unique: Vec<(PathBuf, u16)> = {
        let mut seen = std::collections::HashSet::new();
        placements
            .iter()
            .map(|p| (p.path.clone(), p.rotation_deg))
            .filter(|k| seen.insert(k.clone()))
            .collect()
    };
    let masks: HashMap<(PathBuf, u16), Arc<Mask>> = {
        let _span = tracing::info_span!("rasterize").entered();
        unique
            .into_par_iter()
            .map(|(path, rot)| {
                cache::native_mask(&path, rot).map(|m| ((path, rot), m))
            })
            .collect::<Result<_>>()?
    };

    // Blit sequentially: writes go to overlapping screen regions, and it's
    // memory-bound (cheap) compared to rasterization.
    for p in placements {
        let m = &masks[&(p.path.clone(), p.rotation_deg)];
        goo::blit_max(
            &mut screen,
            SCREEN_W,
            SCREEN_H,
            &m.px,
            m.w,
            m.h,
            p.off_x,
            p.off_y,
        );
    }

    if mirror {
        goo::flip_x(&mut screen, SCREEN_W, SCREEN_H);
    }
    if invert {
        let _span = tracing::info_span!("invert").entered();
        screen.par_iter_mut().for_each(|b| *b = 255 - *b);
    }
    Ok(if screen_rotate {
        goo::rotate180(&screen)
    } else {
        screen
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::goo::{SCREEN_PX_PER_MM_X, SCREEN_PX_PER_MM_Y, SCREEN_X_MM, SCREEN_Y_MM};

    fn dummy_instance(x_mm: f32, y_mm: f32, origin_mm: (f32, f32)) -> PanelInstanceArt {
        PanelInstanceArt {
            mask_path: PathBuf::from("dummy.gbr"),
            origin_mm,
            x_mm,
            y_mm,
            rotation_deg: 0,
        }
    }

    /// Build an `InstancePlacementInput` the way `expose_run::resolve_placements`
    /// does: the outline rotates about its own centre, the copper bbox rotates
    /// about the OUTLINE centre (shared instance pivot).  `unrot_copper_bbox` is
    /// the UNrotated copper bbox `(min_x, min_y, max_x, max_y)`.
    fn rotated_input(
        inst_x: f32,
        inst_y: f32,
        board_origin: (f32, f32),
        board_size: (f32, f32),
        unrot_copper_bbox: (f32, f32, f32, f32),
        deg: u16,
    ) -> InstancePlacementInput {
        let outline_centre = (
            board_origin.0 + board_size.0 / 2.0,
            board_origin.1 + board_size.1 / 2.0,
        );
        let (board_origin_mm, board_size_mm) =
            rotate_bbox_about_centre(board_origin, board_size, deg);
        let (copper_origin, copper_size) = rotate_bbox_about_point(
            (unrot_copper_bbox.0, unrot_copper_bbox.1),
            (
                unrot_copper_bbox.2 - unrot_copper_bbox.0,
                unrot_copper_bbox.3 - unrot_copper_bbox.1,
            ),
            outline_centre,
            deg,
        );
        InstancePlacementInput {
            mask_path: PathBuf::from("dummy.gbr"),
            mask_bbox_mm: (
                copper_origin.0,
                copper_origin.1,
                copper_origin.0 + copper_size.0,
                copper_origin.1 + copper_size.1,
            ),
            board_origin_mm,
            board_size_mm,
            inst_x_mm: inst_x,
            inst_y_mm: inst_y,
            rotation_deg: deg,
        }
    }

    #[test]
    fn panel_placement_positions_instance_at_screen_pixels() {
        let panel_w = 100.0f32;
        let panel_h = 50.0f32;
        let inst = dummy_instance(10.0, 5.0, (0.0, 0.0));
        let result = panel_placements(panel_w, panel_h, &[inst]).unwrap();
        assert_eq!(result.len(), 1);

        let panel_off_x = (SCREEN_X_MM - panel_w) / 2.0;
        let panel_off_y = (SCREEN_Y_MM - panel_h) / 2.0;
        let expected_x = ((panel_off_x + 10.0) * SCREEN_PX_PER_MM_X).round() as i32;
        let expected_y = ((panel_off_y + 5.0) * SCREEN_PX_PER_MM_Y).round() as i32;

        assert_eq!(result[0].off_x, expected_x);
        assert_eq!(result[0].off_y, expected_y);
        assert_eq!(result[0].path, PathBuf::from("dummy.gbr"));
        assert_eq!(result[0].rotation_deg, 0);

        // Hand-computed concrete anchors so a consistently-wrong formula can't pass
        // (the assertions above re-derive with the same formula). For a 100×50 mm
        // panel with the instance at (10, 5) mm and origin (0, 0):
        //   off_x = (55.84 + 10.0) * (15120 / 211.68) ≈ 4702.857 → 4703
        //   off_y = (34.185 + 5.0) * (6230 / 118.37)  ≈ 2062.37  → 2062
        assert_eq!(result[0].off_x, 4703);
        assert_eq!(result[0].off_y, 2062);
    }

    #[test]
    fn panel_placement_rejects_oversized_panel() {
        // A 300×200 mm panel exceeds the ~211.68×118.37 mm exposure screen.
        let inst = dummy_instance(0.0, 0.0, (0.0, 0.0));
        assert!(panel_placements(300.0, 200.0, &[inst]).is_err());
    }

    // ── resolve_panel_placements tests ──────────────────────────────────────

    fn dummy_input(
        inst_x: f32,
        inst_y: f32,
        board_origin: (f32, f32),
        board_size: (f32, f32),
        mask_bbox: (f32, f32, f32, f32),
    ) -> InstancePlacementInput {
        InstancePlacementInput {
            mask_path: PathBuf::from("dummy.gbr"),
            mask_bbox_mm: mask_bbox,
            board_origin_mm: board_origin,
            board_size_mm: board_size,
            inst_x_mm: inst_x,
            inst_y_mm: inst_y,
            rotation_deg: 0,
        }
    }

    /// Test 1 — copper bbox == board outline bbox (degenerate).
    ///
    /// Board outline: [0,10]×[0,8] world (origin=(0,0), size=(10,8)).
    /// Mask bbox == board bbox: min_x=0, min_y=0, max_x=10, max_y=8.
    /// Instance at panel (5, 3).  Panel 50×30 mm.
    ///
    /// Expected origin_mm = (0, 0), i.e. same as panel_placements with
    /// board_origin passed directly.
    ///
    /// Hand-computed pixels (f32, SCREEN 15120×6230, pitch 14×19 µm):
    ///   panel_off_x = (211.68 - 50) / 2 ≈ 80.84
    ///   panel_off_y = (118.37 - 30) / 2 ≈ 44.185
    ///   off_x = (80.84 + 5.0) * 71.4286 ≈ 6131
    ///   off_y = (44.185 + 3.0) * 52.6316 ≈ 2483
    #[test]
    fn resolve_placements_copper_eq_outline_degenerate() {
        let panel_w = 50.0f32;
        let panel_h = 30.0f32;
        // board outline: origin (0,0), size (10,8) → bbox [0,10]×[0,8]
        let item = dummy_input(
            5.0,
            3.0,
            (0.0, 0.0),
            (10.0, 8.0),
            (0.0, 0.0, 10.0, 8.0), // mask == board
        );
        let result = resolve_panel_placements(panel_w, panel_h, &[item]).unwrap();
        assert_eq!(result.len(), 1);

        // Must equal panel_placements with origin_mm = board_origin = (0,0).
        let ref_item = PanelInstanceArt {
            mask_path: PathBuf::from("dummy.gbr"),
            origin_mm: (0.0, 0.0),
            x_mm: 5.0,
            y_mm: 3.0,
            rotation_deg: 0,
        };
        let ref_result = panel_placements(panel_w, panel_h, &[ref_item]).unwrap();
        assert_eq!(result[0].off_x, ref_result[0].off_x);
        assert_eq!(result[0].off_y, ref_result[0].off_y);

        // Pinned concrete pixel anchors.
        assert_eq!(result[0].off_x, 6131);
        assert_eq!(result[0].off_y, 2483);
    }

    /// Test 2 — copper bbox INSET from board outline (the critical Y-flip case).
    ///
    /// Board outline: [0,10]×[0,8] world (origin=(0,0), size=(10,8)).
    /// Copper mask bbox: [1,9]×[1.5,6.5] world — inset 1 mm left/right, 1.5 mm
    /// bottom, 1.5 mm top.
    /// Instance at panel (5, 3).  Panel 50×30 mm.
    ///
    /// By the drill Y-flip:  mask top-left pixel is at world (1, 6.5).
    ///   board-local: dx = 1-0 = 1, dy_up = 6.5-0 = 6.5 (Y-up from board bottom)
    ///   panel: px = 5.0+1.0 = 6.0, py = 3.0+(8.0-6.5) = 4.5
    ///
    /// Hand-computed pixels:
    ///   off_x = (panel_off_x + 6.0) * 71.4286 ≈ 6203
    ///   off_y = (panel_off_y + 4.5) * 52.6316 ≈ 2562
    #[test]
    fn resolve_placements_copper_inset_from_outline() {
        let panel_w = 50.0f32;
        let panel_h = 30.0f32;
        let item = dummy_input(
            5.0,
            3.0,
            (0.0, 0.0),
            (10.0, 8.0),
            (1.0, 1.5, 9.0, 6.5), // copper inset
        );
        let result = resolve_panel_placements(panel_w, panel_h, &[item]).unwrap();
        assert_eq!(result.len(), 1);

        // Pinned concrete pixel anchors (fail if Y-flip or copper/outline delta wrong).
        assert_eq!(
            result[0].off_x, 6203,
            "X offset wrong — copper/outline delta error?"
        );
        assert_eq!(result[0].off_y, 2562, "Y offset wrong — Y-flip error?");
    }

    /// Test 3 — two instances at different positions, same copper/outline geometry.
    ///
    /// Verifies that the per-instance delta depends only on the instance position
    /// difference (the copper/outline offset is the same for both and cancels).
    ///
    /// Instance A at (5, 3), instance B at (20, 10) — same copper inset as Test 2.
    /// Expected delta: dx = (20-5)*PX/mm_x, dy = (10-3)*PX/mm_y.
    #[test]
    fn resolve_placements_two_instances_delta_by_position() {
        let panel_w = 50.0f32;
        let panel_h = 30.0f32;
        let item_a = dummy_input(5.0, 3.0, (0.0, 0.0), (10.0, 8.0), (1.0, 1.5, 9.0, 6.5));
        let item_b = dummy_input(20.0, 10.0, (0.0, 0.0), (10.0, 8.0), (1.0, 1.5, 9.0, 6.5));
        let result = resolve_panel_placements(panel_w, panel_h, &[item_a, item_b]).unwrap();
        assert_eq!(result.len(), 2);

        // Pinned concrete pixel anchors for both (from Test 2 + delta computation).
        assert_eq!(result[0].off_x, 6203);
        assert_eq!(result[0].off_y, 2562);
        assert_eq!(result[1].off_x, 7274);
        assert_eq!(result[1].off_y, 2931);

        // The offset difference must equal the instance-position difference in pixels.
        // Note: f32 rounding accumulation means the difference (1071, 369) may not
        // exactly match `round(15 * px_per_mm)` (1071) / `round(7 * px_per_mm)` (368)
        // independently — we verify with the pinned concrete deltas instead.
        assert_eq!(result[1].off_x - result[0].off_x, 1071); // 15 mm * 71.43 px/mm
        assert_eq!(result[1].off_y - result[0].off_y, 369); // 7 mm * 52.63 px/mm
    }

    #[test]
    fn panel_placement_centers_panel_and_offsets_each_instance() {
        let panel_w = 80.0f32;
        let panel_h = 40.0f32;

        // Instance A: at (0, 0) in panel space, origin at (1.5, 2.0).
        let inst_a = PanelInstanceArt {
            mask_path: PathBuf::from("a.gbr"),
            origin_mm: (1.5, 2.0),
            x_mm: 0.0,
            y_mm: 0.0,
            rotation_deg: 0,
        };
        // Instance B: at (30, 10) in panel space, origin at (0.5, 1.0).
        let inst_b = PanelInstanceArt {
            mask_path: PathBuf::from("b.gbr"),
            origin_mm: (0.5, 1.0),
            x_mm: 30.0,
            y_mm: 10.0,
            rotation_deg: 0,
        };

        let result = panel_placements(panel_w, panel_h, &[inst_a, inst_b]).unwrap();
        assert_eq!(result.len(), 2);

        let panel_off_x = (SCREEN_X_MM - panel_w) / 2.0;
        let panel_off_y = (SCREEN_Y_MM - panel_h) / 2.0;

        // Instance A: panel centering offset minus origin compensated.
        let ax = ((panel_off_x + 0.0 - 1.5) * SCREEN_PX_PER_MM_X).round() as i32;
        let ay = ((panel_off_y + 0.0 - 2.0) * SCREEN_PX_PER_MM_Y).round() as i32;
        assert_eq!(result[0].off_x, ax);
        assert_eq!(result[0].off_y, ay);

        // Instance B: same centering base, shifted by (30 - 0.5) / (10 - 1.0).
        let bx = ((panel_off_x + 30.0 - 0.5) * SCREEN_PX_PER_MM_X).round() as i32;
        let by = ((panel_off_y + 10.0 - 1.0) * SCREEN_PX_PER_MM_Y).round() as i32;
        assert_eq!(result[1].off_x, bx);
        assert_eq!(result[1].off_y, by);

        // Both offsets share the same centering term — verify instance delta is correct.
        let delta_x = result[1].off_x - result[0].off_x;
        let delta_y = result[1].off_y - result[0].off_y;
        // Delta = (30.0 - 0.5 - (0.0 - 1.5)) * px_per_mm = (30.0 - 0.5 + 1.5) * px_per_mm = 31.0 * px_per_mm
        let expected_dx = (31.0_f32 * SCREEN_PX_PER_MM_X).round() as i32;
        // Delta Y = (10.0 - 1.0 - (0.0 - 2.0)) * py_per_mm = (10.0 - 1.0 + 2.0) * py_per_mm = 11.0 * py_per_mm
        let expected_dy = (11.0_f32 * SCREEN_PX_PER_MM_Y).round() as i32;
        assert_eq!(delta_x, expected_dx);
        assert_eq!(delta_y, expected_dy);
    }

    // ── rotate_bbox_about_centre tests ──────────────────────────────────────

    /// Rotation at 0° and 180° must return the same extents/origin as the input
    /// (rectangles are symmetric, centre is invariant).
    ///
    /// Board outline: origin (0,0), size (30,20).  Centre = (15, 10).
    #[test]
    fn rotate_bbox_0_180_unchanged() {
        let origin = (0.0f32, 0.0f32);
        let size = (30.0f32, 20.0f32);

        let (o0, s0) = rotate_bbox_about_centre(origin, size, 0);
        assert_eq!(o0, (0.0, 0.0), "0°: origin");
        assert_eq!(s0, (30.0, 20.0), "0°: size");

        let (o180, s180) = rotate_bbox_about_centre(origin, size, 180);
        assert_eq!(o180, (0.0, 0.0), "180°: origin");
        assert_eq!(s180, (30.0, 20.0), "180°: size");
    }

    /// 90° and 270° must swap width↔height and shift the origin so the centre
    /// stays at (15, 10).
    ///
    /// Rotated size: (20, 30).
    /// Rotated origin: (cx − 10, cy − 15) = (15 − 10, 10 − 15) = (5, −5).
    #[test]
    fn rotate_bbox_90_270_swaps_extents() {
        let origin = (0.0f32, 0.0f32);
        let size = (30.0f32, 20.0f32);

        let (o90, s90) = rotate_bbox_about_centre(origin, size, 90);
        assert_eq!(s90, (20.0, 30.0), "90°: size should swap");
        assert_eq!(o90, (5.0, -5.0), "90°: origin should shift to keep centre at (15,10)");

        let (o270, s270) = rotate_bbox_about_centre(origin, size, 270);
        assert_eq!(s270, (20.0, 30.0), "270°: size should swap");
        assert_eq!(o270, (5.0, -5.0), "270°: origin should shift to keep centre at (15,10)");
    }

    /// A non-zero-origin board confirms that the centre pivot uses the actual
    /// geometric centre, not (0,0).
    ///
    /// Board outline: origin (2, 3), size (10, 6).  Centre = (7, 6).
    /// 90°: size = (6, 10), origin = (7−3, 6−5) = (4, 1).
    #[test]
    fn rotate_bbox_nonzero_origin_90() {
        let origin = (2.0f32, 3.0f32);
        let size = (10.0f32, 6.0f32);
        let (o, s) = rotate_bbox_about_centre(origin, size, 90);
        assert_eq!(s, (6.0, 10.0), "90° non-zero origin: size");
        // cx=7, cy=6; rot_w=6, rot_h=10 → rot_origin = (7-3, 6-5) = (4, 1)
        assert_eq!(o, (4.0, 1.0), "90° non-zero origin: origin");
    }

    // ── rotate_bbox_about_point tests ────────────────────────────────────────

    /// Rotating about the rectangle's own centre must match
    /// [`rotate_bbox_about_centre`] (the latter is the special case).
    #[test]
    fn rotate_bbox_about_point_self_centre_matches_centre_helper() {
        let origin = (2.0f32, 3.0f32);
        let size = (10.0f32, 6.0f32);
        let pivot = (origin.0 + size.0 / 2.0, origin.1 + size.1 / 2.0);
        for deg in [0u16, 90, 180, 270] {
            let a = rotate_bbox_about_centre(origin, size, deg);
            let b = rotate_bbox_about_point(origin, size, pivot, deg);
            assert_eq!(a, b, "deg {deg}: self-pivot should equal rotate_bbox_about_centre");
        }
    }

    /// Copper bbox rotated about a DIFFERENT pivot (the outline centre).
    ///
    /// Copper bbox (1,1)-(9,5)  [origin (1,1), size (8,4)], own centre (5,3).
    /// Outline centre = (5,4)   (copper sits 1 mm below outline centre in Y-up).
    ///
    /// 90° CCW (Y-up) about (5,4):
    ///   corner (1,1) → (5−(1−4), 4+(1−5)) = (8, 0)
    ///   corner (9,1) → (5−(1−4), 4+(9−5)) = (8, 8)
    ///   corner (1,5) → (5−(5−4), 4+(1−5)) = (4, 0)
    ///   corner (9,5) → (5−(5−4), 4+(9−5)) = (4, 8)
    ///   AABB → origin (4,0), size (4,8).  (Size = swapped extents, pivot-invariant.)
    ///
    /// Crucially the rotated copper centre is (6,4) ≠ outline centre (5,4) — the
    /// inter-centre offset is preserved as a rigid rotation, NOT collapsed.
    #[test]
    fn rotate_bbox_about_point_copper_about_outline_centre_90() {
        let copper_origin = (1.0f32, 1.0f32);
        let copper_size = (8.0f32, 4.0f32);
        let outline_centre = (5.0f32, 4.0f32);

        let (o90, s90) = rotate_bbox_about_point(copper_origin, copper_size, outline_centre, 90);
        assert_eq!(o90, (4.0, 0.0), "90°: origin (rotated about outline centre)");
        assert_eq!(s90, (4.0, 8.0), "90°: size (extents swap, pivot-invariant)");

        // 270° CCW about (5,4):
        //   (1,1) → (5+(1−4), 4−(1−5)) = (2, 8)
        //   (9,5) → (5+(5−4), 4−(9−5)) = (6, 0)
        //   AABB → origin (2,0), size (4,8).
        let (o270, s270) = rotate_bbox_about_point(copper_origin, copper_size, outline_centre, 270);
        assert_eq!(o270, (2.0, 0.0), "270°: origin (rotated about outline centre)");
        assert_eq!(s270, (4.0, 8.0), "270°: size");

        // 90° and 270° land the copper on OPPOSITE sides of the outline centre —
        // the asymmetry the buggy copper-centred rotation could not distinguish.
        assert_ne!(o90, o270, "90° and 270° copper positions must differ for asymmetric copper");
    }

    // ── resolve_panel_placements rotation tests ──────────────────────────────

    /// Test 4 — 90° rotation, copper centred on the outline (degenerate pivot case).
    ///
    /// Board outline: origin=(0,0), size=(10,8).  Centre=(5,4).
    /// Copper mask unrotated: (1,1.5,9,6.5), centre=(5,4) == outline centre.
    /// Because the centres coincide, copper-about-outline-centre and
    /// copper-about-own-centre agree, so the pinned values are the same as in the
    /// first (now-fixed) version of this test.
    ///
    /// Rotated outline (90°): size=(8,10), origin=(1,−1).
    /// Rotated copper (90° about (5,4)): size=(5,8), origin=(2.5,0).
    ///   → mask_bbox_mm = (2.5, 0, 7.5, 8).
    ///   origin_x = 1 − 2.5 = −1.5 ; origin_y = 8 − (−1 + 10) = −1
    ///   off_x = (80.84 + 5.0 − (−1.5)) * 71.4286 ≈ 6239
    ///   off_y = (44.185 + 3.0 − (−1)) * 52.6316  ≈ 2536
    #[test]
    fn resolve_placements_rotated_90_copper_centred() {
        let item = rotated_input(5.0, 3.0, (0.0, 0.0), (10.0, 8.0), (1.0, 1.5, 9.0, 6.5), 90);
        let result = resolve_panel_placements(50.0, 30.0, &[item]).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].rotation_deg, 90, "rotation_deg must be carried through");
        assert_eq!(result[0].off_x, 6239, "X offset wrong for 90° rotation");
        assert_eq!(result[0].off_y, 2536, "Y offset wrong for 90° rotation");
    }

    /// Test 5 — 270°, copper centred on the outline.  Same screen position as 90°
    /// here (the copper is symmetric about the outline centre), but `rotation_deg`
    /// is 270.
    #[test]
    fn resolve_placements_rotated_270_copper_centred() {
        let item = rotated_input(5.0, 3.0, (0.0, 0.0), (10.0, 8.0), (1.0, 1.5, 9.0, 6.5), 270);
        let result = resolve_panel_placements(50.0, 30.0, &[item]).unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].rotation_deg, 270, "rotation_deg must be carried through");
        assert_eq!(result[0].off_x, 6239, "X offset wrong for 270° rotation");
        assert_eq!(result[0].off_y, 2536, "Y offset wrong for 270° rotation");
    }

    /// Test 4b — THE CATCHING TEST: copper centre ≠ outline centre.
    ///
    /// Board outline: origin=(0,0), size=(10,8).  Centre=(5,4).
    /// Copper bbox UNROTATED: (1,1)-(9,5).  Centre=(5,3) — 1 mm below the outline
    /// centre.  This asymmetry is what real boards have (copper isn't symmetric in
    /// the outline) and is exactly what the original Phase-2 code got wrong.
    ///
    /// CORRECT (copper rotated about the OUTLINE centre (5,4)):
    ///   90°:  mask_bbox = (4, 0, 8, 8) → off = (6346, 2536)
    ///   270°: mask_bbox = (2, 0, 6, 8) → off = (6203, 2536)
    ///   90° and 270° land on OPPOSITE sides → off_x differs.
    ///
    /// BUGGY (copper rotated about its OWN centre (5,3)) would yield:
    ///   both 90° and 270°: mask_bbox = (3, −1, 7, 7) → off = (6274, 2589)
    /// i.e. wrong, and indistinguishable between 90/270 — this test fails under
    /// the old code at BOTH the value and the 90≠270 assertions.
    #[test]
    fn resolve_placements_rotated_asymmetric_copper_catches_pivot_bug() {
        let item90 = rotated_input(5.0, 3.0, (0.0, 0.0), (10.0, 8.0), (1.0, 1.0, 9.0, 5.0), 90);
        let r90 = resolve_panel_placements(50.0, 30.0, &[item90]).unwrap();
        assert_eq!(r90[0].rotation_deg, 90);
        // CORRECT values (copper about outline centre). Old buggy code → (6274, 2589).
        assert_eq!(r90[0].off_x, 6346, "90° X — copper must rotate about OUTLINE centre");
        assert_eq!(r90[0].off_y, 2536, "90° Y — copper must rotate about OUTLINE centre");

        let item270 = rotated_input(5.0, 3.0, (0.0, 0.0), (10.0, 8.0), (1.0, 1.0, 9.0, 5.0), 270);
        let r270 = resolve_panel_placements(50.0, 30.0, &[item270]).unwrap();
        assert_eq!(r270[0].rotation_deg, 270);
        assert_eq!(r270[0].off_x, 6203, "270° X — copper must rotate about OUTLINE centre");
        assert_eq!(r270[0].off_y, 2536, "270° Y — copper must rotate about OUTLINE centre");

        // The decisive guard: asymmetric copper lands on opposite sides at 90 vs
        // 270.  The buggy copper-centred rotation produced identical offsets here.
        assert_ne!(
            r90[0].off_x, r270[0].off_x,
            "asymmetric copper must place differently at 90° vs 270°"
        );

        // And both differ from the buggy value (6274) — a hard regression pin.
        assert_ne!(r90[0].off_x, 6274, "90° must NOT match the buggy copper-centred result");
        assert_ne!(r270[0].off_x, 6274, "270° must NOT match the buggy copper-centred result");
    }

    /// Test 6 — 0° resolve test still passes with new code path (regression guard).
    ///
    /// Repeats the same geometry as Test 2 (copper inset) to confirm the 0°
    /// case is unchanged after the rotation plumbing was added.
    #[test]
    fn resolve_placements_0deg_unchanged_after_rotation_plumbing() {
        let panel_w = 50.0f32;
        let panel_h = 30.0f32;
        let item = InstancePlacementInput {
            mask_path: PathBuf::from("dummy.gbr"),
            mask_bbox_mm: (1.0, 1.5, 9.0, 6.5),
            board_origin_mm: (0.0, 0.0),
            board_size_mm: (10.0, 8.0),
            inst_x_mm: 5.0,
            inst_y_mm: 3.0,
            rotation_deg: 0,
        };
        let result = resolve_panel_placements(panel_w, panel_h, &[item]).unwrap();
        assert_eq!(result.len(), 1);
        // These are the same values as Test 2.
        assert_eq!(result[0].off_x, 6203, "0° X offset regressed");
        assert_eq!(result[0].off_y, 2562, "0° Y offset regressed");
        assert_eq!(result[0].rotation_deg, 0);
    }
}
