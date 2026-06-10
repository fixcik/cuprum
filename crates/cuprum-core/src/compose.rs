//! Compose one or more Gerber placements onto the full exposure screen.
//!
//! This is the bridge between rendering (per-file masks) and the `.goo` encoder:
//! it blits every placement into a single 15120×6230 buffer, applies the global
//! emulsion-down mirror / resist inversion, and the printer's 180° orientation
//! correction. The result is ready for [`goo::single_layer_exposure`].
//!
//! Designed for the layout editor: today the UI/CLI pass a single placement, but
//! the list-based API extends to many copies on one board without changing shape.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use rayon::prelude::*;

use crate::cache::{self, Mask};
use crate::goo::{self, SCREEN_H, SCREEN_W};

/// One Gerber instance positioned on the screen. `off_x`/`off_y` are the
/// top-left of the rendered mask in screen pixels. `rotation_deg` is reserved
/// for the layout editor (0 supported now; 90/270 needs an anisotropy-aware
/// re-render and lands with the nesting milestone).
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
    pub origin_mm: (f32, f32),
    /// Instance top-left X position in panel space (mm).
    pub x_mm: f32,
    /// Instance top-left Y position in panel space (mm).
    pub y_mm: f32,
    /// Rotation in degrees (0, 90, 180, 270). Only 0 and 180 are fully supported;
    /// 90/270 will be composited without rotation (warn is emitted).
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
/// Rotation 90°/270° is NOT yet supported by the blit loop (see
/// `TODO(nesting)` in `compose_layout`). Instances with such rotations are passed
/// through with `rotation_deg` intact, but a [`tracing::warn!`] is emitted per
/// instance and the mask will be composited without rotation.
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
            if inst.rotation_deg == 90 || inst.rotation_deg == 270 {
                tracing::warn!(
                    path = %inst.mask_path.display(),
                    rotation_deg = inst.rotation_deg,
                    "rotation 90/270 is not yet supported; instance will be exposed unrotated"
                );
            }

            let off_x =
                ((panel_off_x + inst.x_mm - inst.origin_mm.0) * SCREEN_PX_PER_MM_X).round()
                    as i32;
            let off_y =
                ((panel_off_y + inst.y_mm - inst.origin_mm.1) * SCREEN_PX_PER_MM_Y).round()
                    as i32;

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

/// Input for [`resolve_panel_placements`]: one board instance with enough
/// geometry to correctly align the copper mask to the board outline corner.
#[derive(Clone, Debug)]
pub struct InstancePlacementInput {
    /// Path to the copper Gerber layer (not read here — passed through to [`Placement`]).
    pub mask_path: PathBuf,
    /// Copper mask bounding box in Gerber world coords (Y-up), from [`Mask`].
    /// Fields: `(min_x_mm, min_y_mm, max_x_mm, max_y_mm)`.
    pub mask_bbox_mm: (f32, f32, f32, f32),
    /// Board outline bbox MIN corner (bottom-left, Gerber Y-up), from board metrics.
    pub board_origin_mm: (f32, f32),
    /// Board outline size in mm (`width, height`), from board metrics.
    pub board_size_mm: (f32, f32),
    /// Instance top-left position in panel space (mm, Y-down, origin top-left).
    pub inst_x_mm: f32,
    /// Instance top-left position in panel space (mm, Y-down, origin top-left).
    pub inst_y_mm: f32,
    /// Rotation in degrees (0, 90, 180, 270).  Only 0/180 fully supported.
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
/// # Errors / warnings
/// Same as [`panel_placements`] (panel-too-large error; 90/270 rotation warning).
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

    // Resolve each UNIQUE file's native mask once (auto-arrange spawns many
    // copies of the same file), in parallel, through the cache — so repeat
    // exposes and reloads reuse the raster instead of re-rendering.
    let unique: Vec<PathBuf> = {
        let mut seen = std::collections::HashSet::new();
        placements
            .iter()
            .map(|p| p.path.clone())
            .filter(|p| seen.insert(p.clone()))
            .collect()
    };
    let masks: HashMap<PathBuf, Arc<Mask>> = {
        let _span = tracing::info_span!("rasterize").entered();
        unique
            .into_par_iter()
            .map(|path| cache::native_mask(&path).map(|m| (path, m)))
            .collect::<Result<_>>()?
    };

    // Blit sequentially: writes go to overlapping screen regions, and it's
    // memory-bound (cheap) compared to rasterization.
    // TODO(nesting): honor rotation_deg 90/270 via a rotated re-render.
    for p in placements {
        let m = &masks[&p.path];
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
        assert_eq!(result[0].off_x, 6203, "X offset wrong — copper/outline delta error?");
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
        assert_eq!(result[1].off_y - result[0].off_y, 369);  // 7 mm * 52.63 px/mm
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
}
