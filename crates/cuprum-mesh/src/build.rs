//! Board assembly: triangulate the FR4 substrate (drilled faces + walls) and
//! each surface layer, then join them — substrate and surface layers build
//! concurrently — into a [`BoardMesh`](super::BoardMesh).

use cuprum_gerber::geometry::{self, Hole};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::overlay::FloatOverlay;
use rayon::prelude::*;

use super::emit::{add_barrel, add_slab, add_wall, emit_face, triangulate_poly};
use super::outline::outline_loops;
use super::{
    layer_z_range, BoardMesh, Buffer, LayerInput, LayerMesh, Role, DRILL_SEGS, KIND_BARREL,
    KIND_COPPER, KIND_MASK, KIND_OTHER, KIND_SILK,
};

/// Build the FR4 substrate: top + bottom faces (drilled through) and the
/// perimeter + inner-cutout walls. Drill bores get copper barrels instead of
/// FR4 walls (added per drill layer), so they don't z-fight.
#[tracing::instrument(skip_all, fields(loops = loops.len(), holes = holes.len()))]
fn build_substrate(loops: &[Vec<[f64; 2]>], holes: &[Hole], thickness: f32) -> Buffer {
    let mut buf = Buffer::default();
    if loops.is_empty() {
        return buf;
    }
    let outer = vec![loops[0].clone()];
    // Inner cutouts + drill circles are subtracted from the board faces.
    let mut clip: Vec<Vec<[f64; 2]>> = loops[1..].to_vec();
    for h in holes {
        if h.d > 0.0 {
            clip.push(geometry::circle(h.x, h.y, h.d / 2.0, DRILL_SEGS));
        }
    }
    let board_polys = {
        // Drilling the faces is a boolean difference against every hole circle —
        // the suspect cost when a board has thousands of holes.
        let _span = tracing::info_span!("drill_faces", clip = clip.len()).entered();
        let shapes = if clip.is_empty() {
            FloatOverlay::with_subj(&outer).overlay(OverlayRule::Subject, FillRule::NonZero)
        } else {
            FloatOverlay::with_subj_and_clip(&outer, &clip)
                .overlay(OverlayRule::Difference, FillRule::NonZero)
        };
        geometry::shapes_to_polys(shapes)
    };
    {
        let _span = tracing::info_span!("triangulate_faces", polys = board_polys.len()).entered();
        for p in &board_polys {
            // Top + bottom faces share the SAME 2D polygon — earcut once, emit
            // both. (Top first, then bottom, to match the prior vertex order.)
            if let Some((data, tris)) = triangulate_poly(p) {
                emit_face(&mut buf, &data, &tris, thickness, 1.0); // top face
                emit_face(&mut buf, &data, &tris, 0.0, -1.0); // bottom face
            }
        }
    }
    // Walls only for the perimeter + inner cutouts (NOT drills).
    add_wall(&mut buf, &loops[0], 0.0, thickness);
    for inner in &loops[1..] {
        add_wall(&mut buf, inner, 0.0, thickness);
    }
    buf
}

/// Triangulate one surface layer into a `LayerMesh`, or `None` if empty / not a
/// surface (edge/drill handled elsewhere).
#[tracing::instrument(skip_all, fields(key = %layer.key, role = ?layer.role))]
fn build_surface_layer(
    layer: &LayerInput,
    holes: &[Hole],
    outline: &[Vec<[f64; 2]>],
    thickness: f32,
) -> Option<LayerMesh> {
    let (kind, is_mask) = match layer.role {
        Role::Copper => (KIND_COPPER, false),
        Role::Mask => (KIND_MASK, true),
        Role::Silk => (KIND_SILK, false),
        Role::Paste | Role::Other => (KIND_OTHER, false),
        Role::Edge | Role::Drill => return None,
    };
    // Boolean stage: fills/clears unioned, drill bores subtracted (mask = board
    // minus openings). Usually the dominant cost per layer.
    let polys = {
        let _span = tracing::info_span!("polygons", is_mask).entered();
        if is_mask {
            if outline.is_empty() {
                return None;
            }
            geometry::mask_polygons(outline, layer.bytes, holes).ok()?
        } else {
            geometry::layer_polygons(layer.bytes, holes).ok()?
        }
    };
    if polys.is_empty() {
        return None;
    }
    // Each layer is an extruded slab (real thickness) sitting flush on the surface
    // beneath it, so it reads as solid material instead of a floating plane.
    let (z0, z1) = layer_z_range(layer.role, layer.side, thickness);
    let mut buf = Buffer::default();
    {
        let _span = tracing::info_span!("triangulate", polys = polys.len()).entered();
        for p in &polys {
            add_slab(&mut buf, p, z0, z1);
        }
    }
    if buf.positions.is_empty() {
        return None;
    }
    Some(LayerMesh {
        key: layer.key.clone(),
        kind,
        buffer: buf,
    })
}

/// Build the complete board mesh from every layer's raw bytes.
///
/// - Drill layers → parsed for holes; each also yields a `KIND_BARREL` layer
///   mesh (its bores) so the frontend can toggle that drill's holes.
/// - Edge layer → stitched into the board outline (perimeter + inner cutouts).
/// - Surface layers (copper/mask/silk/paste/other) → clean polygons
///   (drill-subtracted; mask = board minus openings) triangulated in parallel.
#[tracing::instrument(skip_all, fields(layers = layers.len(), thickness))]
pub fn board_geometry(layers: &[LayerInput], thickness: f32) -> BoardMesh {
    // 1. Collect ALL drill holes (used to drill the substrate faces and cut fills).
    let mut holes: Vec<Hole> = Vec::new();
    {
        let _span = tracing::info_span!("collect_holes").entered();
        for l in layers {
            if l.role == Role::Drill {
                if let Ok(hs) = cuprum_gerber::drill::parse_drill(l.bytes) {
                    for h in hs {
                        holes.push(Hole {
                            x: h.x_mm as f64,
                            y: h.y_mm as f64,
                            d: h.d_mm as f64,
                        });
                    }
                }
            }
        }
    }

    // 2. Board outline from the Edge layer (if any).
    let outline = {
        let _span = tracing::info_span!("outline").entered();
        layers
            .iter()
            .find(|l| l.role == Role::Edge)
            .map(|e| outline_loops(e.bytes))
            .unwrap_or_default()
    };

    // 3 + 4. The substrate and the surface layers are independent (both need only
    // `outline` + `holes`, already computed), so build them concurrently — the
    // substrate's sequential earcut overlaps the parallel surface-layer region
    // instead of running before it. Capture the current span so spans created on
    // rayon workers (either side of the join, possibly stolen onto a worker
    // thread) stay its children and route to this operation's trace file.
    let dh = cuprum_trace::capture_dispatch();
    let (substrate, mut meshes) = rayon::join(
        || dh.run(|| build_substrate(&outline, &holes, thickness)),
        || {
            dh.run(|| {
                let _span = tracing::info_span!("triangulate_parallel").entered();
                let dh = cuprum_trace::capture_dispatch();
                layers
                    .par_iter()
                    .filter_map(|l| dh.run(|| build_surface_layer(l, &holes, &outline, thickness)))
                    .collect::<Vec<LayerMesh>>()
            })
        },
    );

    // 5. One barrel mesh per drill layer (keyed by that layer, so it toggles).
    {
        let _span = tracing::info_span!("barrels").entered();
        for l in layers {
            if l.role != Role::Drill {
                continue;
            }
            let Ok(hs) = cuprum_gerber::drill::parse_drill(l.bytes) else {
                continue;
            };
            let mut buf = Buffer::default();
            for h in &hs {
                if h.d_mm > 0.0 {
                    // Barrel at the true drill radius (flush with the bore). The
                    // copper/mask hole walls sit at the same radius, so the barrel
                    // wins their depth tie via a render-side polygonOffset in the
                    // frontend (KIND_BARREL material) — no geometry is altered.
                    add_barrel(&mut buf, h.x_mm, h.y_mm, h.d_mm / 2.0, 0.0, thickness);
                }
            }
            if !buf.positions.is_empty() {
                meshes.push(LayerMesh {
                    key: l.key.clone(),
                    kind: KIND_BARREL,
                    buffer: buf,
                });
            }
        }
    }

    BoardMesh {
        substrate,
        layers: meshes,
    }
}
