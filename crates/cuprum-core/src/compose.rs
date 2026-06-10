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
    /// Instance top-left position in panel space (mm).
    pub x_mm: f32,
    /// Instance top-left position in panel space (mm).
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
pub fn panel_placements(
    panel_w_mm: f32,
    panel_h_mm: f32,
    instances: &[PanelInstanceArt],
) -> Result<Vec<Placement>> {
    use crate::goo::{SCREEN_PX_PER_MM_X, SCREEN_PX_PER_MM_Y, SCREEN_X_MM, SCREEN_Y_MM};

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
