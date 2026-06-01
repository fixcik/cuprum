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
