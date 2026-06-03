//! Full 3D board mesh, triangulated entirely in Rust.
//!
//! The 3D preview used to build all of its geometry on the JS main thread:
//! parse ~1 MB SVG strings, union/difference pad-and-pour fills with
//! `polygon-clipping`, stroke + centroid-cut tens of thousands of traces, then
//! `earcut`-triangulate the result — and finally spawn one `<mesh>` per drill
//! hole. On a dense board (a 4×12 keyboard: ~48 k copper traces, ~39 k silk
//! segments, 537 drills) that froze the UI for ~20 s and never cut the silk at
//! drill holes.
//!
//! This module moves ALL of that off the main thread: given the raw gerber bytes
//! for every layer plus their roles, it produces ready-to-upload triangle
//! buffers (positions / normals / indices, with the per-layer Z already baked
//! in). The frontend just wraps them in `BufferGeometry` — no booleans, no
//! triangulation, no per-hole meshes, no million-element `JSON.parse`.
//!
//! It builds on [`crate::geometry`] for the clean, drill-subtracted fill
//! polygons (`layer_polygons` / `mask_polygons`), and on [`crate::drill`] for
//! the holes. Surface layers are triangulated in parallel with `rayon`.

use std::f64::consts::TAU;

use gerber_viewer::{GerberLayer, GerberPrimitive};
use i_overlay::core::fill_rule::FillRule;
use i_overlay::core::overlay_rule::OverlayRule;
use i_overlay::float::overlay::FloatOverlay;
use rayon::prelude::*;

use crate::geometry::{self, Hole, Poly};

/// FR4 substrate thickness in mm (matches the JS `FR4_THICK`).
const FR4_THICK: f32 = 1.6;
/// Drill-bore cylinder facet count.
const BARREL_SEGS: usize = 24;
/// Facets for circles used when difference-drilling the substrate faces.
const DRILL_SEGS: usize = 32;
/// Endpoint-match tolerance (mm) when stitching the Edge_Cuts outline.
const STITCH_EPS: f64 = 1e-3;
/// Arc tessellation for the Edge_Cuts outline.
const EDGE_ARC_STEPS: usize = 48;

// Surface "kind" tags shared with the frontend (it picks the material).
pub const KIND_COPPER: u8 = 0;
pub const KIND_MASK: u8 = 1;
pub const KIND_SILK: u8 = 2;
pub const KIND_OTHER: u8 = 3;
pub const KIND_BARREL: u8 = 4;

/// The geometric role of a gerber layer (independent of `cuprum-project`'s
/// `LayerType`, so the core stays free of that dependency). The caller maps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Copper,
    Mask,
    Silk,
    Paste,
    Edge,
    Drill,
    Other,
}

/// Which face a layer lives on (drives the baked Z and normal direction).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    Top,
    Bottom,
    Both,
}

/// One input gerber layer: its stable key (used by the frontend to toggle
/// visibility), its role, its side, and the raw bytes.
pub struct LayerInput<'a> {
    pub key: String,
    pub role: Role,
    pub side: Side,
    pub bytes: &'a [u8],
}

/// A triangle buffer: interleaved-free positions/normals (xyz triples) and a
/// `u32` index list.
#[derive(Default, Clone)]
pub struct Buffer {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub indices: Vec<u32>,
}

impl Buffer {
    fn vert_count(&self) -> u32 {
        (self.positions.len() / 3) as u32
    }

    fn push_vert(&mut self, x: f32, y: f32, z: f32, nx: f32, ny: f32, nz: f32) {
        self.positions.extend_from_slice(&[x, y, z]);
        self.normals.extend_from_slice(&[nx, ny, nz]);
    }
}

/// One triangulated surface layer, tagged by key + kind for the frontend.
pub struct LayerMesh {
    pub key: String,
    pub kind: u8,
    pub buffer: Buffer,
}

/// The complete board: the FR4 substrate, plus per-layer surface/barrel meshes.
/// Barrels are emitted as `KIND_BARREL` layer meshes keyed by their drill layer,
/// so the frontend can toggle a drill layer's holes like any other layer.
pub struct BoardMesh {
    pub substrate: Buffer,
    pub layers: Vec<LayerMesh>,
}

/// Z of a surface layer plane: bottom layers hang below z=0, top layers sit
/// above the FR4. Offsets spread the stack so it stays separable in the depth
/// buffer (matches the JS `zOffsetFor`).
fn z_for(role: Role, side: Side) -> f32 {
    let off = match role {
        Role::Copper => 0.03,
        Role::Mask => 0.08,
        Role::Silk | Role::Paste => 0.14,
        _ => 0.03,
    };
    match side {
        Side::Bottom => -off,
        _ => FR4_THICK + off,
    }
}

/// Earcut a polygon (outer ring + holes) once, returning the flattened XY vertex
/// data and the triangle index list — both reusable across multiple faces of the
/// SAME 2D shape (e.g. the substrate's top + bottom). `None` if degenerate.
/// Robust for SIMPLE polygons, which is what `geometry` produces after the
/// boolean union/difference.
fn triangulate_poly(poly: &Poly) -> Option<(Vec<f64>, Vec<usize>)> {
    if poly.outer.len() < 3 {
        return None;
    }
    let mut data: Vec<f64> = Vec::with_capacity(poly.outer.len() * 2);
    for p in &poly.outer {
        data.push(p[0] as f64);
        data.push(p[1] as f64);
    }
    let mut hole_indices: Vec<usize> = Vec::with_capacity(poly.holes.len());
    for hole in &poly.holes {
        if hole.len() < 3 {
            continue;
        }
        hole_indices.push(data.len() / 2);
        for p in hole {
            data.push(p[0] as f64);
            data.push(p[1] as f64);
        }
    }
    let tris = earcutr::earcut(&data, &hole_indices, 2).ok()?;
    Some((data, tris))
}

/// Emit one flat face from a pre-triangulated polygon (`data` + `tris` from
/// [`triangulate_poly`]) into `buf` at constant `z`, with a flat normal of
/// `(0, 0, nz)`.
fn emit_face(buf: &mut Buffer, data: &[f64], tris: &[usize], z: f32, nz: f32) {
    let base = buf.vert_count();
    let vert_n = data.len() / 2;
    for i in 0..vert_n {
        buf.push_vert(data[2 * i] as f32, data[2 * i + 1] as f32, z, 0.0, 0.0, nz);
    }
    // earcut emits CCW triangles (front toward +Z). For a downward-facing layer
    // (nz < 0) reverse the winding so it MATCHES the -Z normal — otherwise, under
    // a DoubleSide material, three.js flips the normal by gl_FrontFacing and the
    // bottom copper lights as if facing away (no specular: dull back, shiny front).
    for tri in tris.chunks_exact(3) {
        let (a, b, c) = (
            base + tri[0] as u32,
            base + tri[1] as u32,
            base + tri[2] as u32,
        );
        if nz < 0.0 {
            buf.indices.extend_from_slice(&[a, c, b]);
        } else {
            buf.indices.extend_from_slice(&[a, b, c]);
        }
    }
}

/// Triangulate one polygon into `buf` at constant `z` with a flat `(0, 0, nz)`
/// normal. Convenience for surface layers (one face per polygon).
fn add_poly(buf: &mut Buffer, poly: &Poly, z: f32, nz: f32) {
    if let Some((data, tris)) = triangulate_poly(poly) {
        emit_face(buf, &data, &tris, z, nz);
    }
}

/// Add a vertical wall along a closed ring, from `z0` up to `z1`, with outward
/// horizontal normals. For a CCW ring the normal `(dy, -dx)` points outward.
fn add_wall(buf: &mut Buffer, ring: &[[f64; 2]], z0: f32, z1: f32) {
    let n = ring.len();
    if n < 2 {
        return;
    }
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        let dx = (b[0] - a[0]) as f32;
        let dy = (b[1] - a[1]) as f32;
        let len = (dx * dx + dy * dy).sqrt();
        if len < 1e-9 {
            continue;
        }
        let (nx, ny) = (dy / len, -dx / len);
        let (ax, ay) = (a[0] as f32, a[1] as f32);
        let (bx, by) = (b[0] as f32, b[1] as f32);
        let base = buf.vert_count();
        buf.push_vert(ax, ay, z0, nx, ny, 0.0);
        buf.push_vert(bx, by, z0, nx, ny, 0.0);
        buf.push_vert(bx, by, z1, nx, ny, 0.0);
        buf.push_vert(ax, ay, z1, nx, ny, 0.0);
        buf.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
}

/// Add a drill-bore cylinder wall (open tube) with inward-facing normals, so the
/// plated through-hole reads as connected copper between the top and bottom pads.
fn add_barrel(buf: &mut Buffer, cx: f32, cy: f32, r: f32, z0: f32, z1: f32) {
    for i in 0..BARREL_SEGS {
        let a0 = i as f32 / BARREL_SEGS as f32 * TAU as f32;
        let a1 = (i + 1) as f32 / BARREL_SEGS as f32 * TAU as f32;
        let (c0, s0) = (a0.cos(), a0.sin());
        let (c1, s1) = (a1.cos(), a1.sin());
        let (x0, y0) = (cx + r * c0, cy + r * s0);
        let (x1, y1) = (cx + r * c1, cy + r * s1);
        let base = buf.vert_count();
        // Inward normals (-cos, -sin): viewer looks into the bore.
        buf.push_vert(x0, y0, z0, -c0, -s0, 0.0);
        buf.push_vert(x1, y1, z0, -c1, -s1, 0.0);
        buf.push_vert(x1, y1, z1, -c1, -s1, 0.0);
        buf.push_vert(x0, y0, z1, -c0, -s0, 0.0);
        buf.indices
            .extend_from_slice(&[base, base + 1, base + 2, base, base + 2, base + 3]);
    }
}

/// Edge_Cuts CENTERLINE segments (Line/Arc, arcs tessellated). Flashed cap
/// circles / fills are ignored — they're not part of the cut path.
fn edge_segments(edge_bytes: &[u8]) -> Vec<([f64; 2], [f64; 2])> {
    let reader = std::io::BufReader::new(std::io::Cursor::new(edge_bytes));
    let doc = match gerber_viewer::gerber_parser::parse(reader) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    let layer = GerberLayer::new(doc.into_commands());
    let mut segs: Vec<([f64; 2], [f64; 2])> = Vec::new();
    for prim in layer.primitives() {
        match prim {
            GerberPrimitive::Line(l) => {
                segs.push(([l.start.x, l.start.y], [l.end.x, l.end.y]));
            }
            GerberPrimitive::Arc(a) => {
                let mut prev: Option<[f64; 2]> = None;
                for i in 0..=EDGE_ARC_STEPS {
                    let t = i as f64 / EDGE_ARC_STEPS as f64;
                    let ang = a.start_angle + a.sweep_angle * t;
                    let pt = [
                        a.center.x + a.radius * ang.cos(),
                        a.center.y + a.radius * ang.sin(),
                    ];
                    if let Some(p) = prev {
                        segs.push((p, pt));
                    }
                    prev = Some(pt);
                }
            }
            // Circles/Rectangles/Polygons on Edge_Cuts are cap dots or fills — ignore.
            _ => {}
        }
    }
    segs
}

/// Edge_Cuts outline loops plus whether the board PERIMETER (largest loop)
/// closed. Perimeter first, then inner cutouts. Used by the metrics module to
/// report board size, cutout count and whether the outline forms a closed shape.
pub(crate) fn outline_info(edge_bytes: &[u8]) -> (Vec<Vec<[f64; 2]>>, bool) {
    let loops = stitch(edge_segments(edge_bytes));
    let perimeter_closed = loops.first().map(|(_, closed)| *closed).unwrap_or(false);
    (
        loops.into_iter().map(|(ring, _)| ring).collect(),
        perimeter_closed,
    )
}

/// Edge_Cuts outline loops only (perimeter first, then inner cutouts).
fn outline_loops(edge_bytes: &[u8]) -> Vec<Vec<[f64; 2]>> {
    outline_info(edge_bytes).0
}

/// Stitch a soup of segments into closed loops by matching endpoints (greedy),
/// returning each loop with a flag for whether it actually closed (vs an open
/// chain that ran out of matching segments). Edge_Cuts is tiny (a handful of
/// segments), so O(n²) chaining is fine.
fn stitch(segs: Vec<([f64; 2], [f64; 2])>) -> Vec<(Vec<[f64; 2]>, bool)> {
    let near = |a: [f64; 2], b: [f64; 2]| {
        (a[0] - b[0]).abs() < STITCH_EPS && (a[1] - b[1]).abs() < STITCH_EPS
    };
    let mut used = vec![false; segs.len()];
    let mut loops: Vec<(Vec<[f64; 2]>, bool)> = Vec::new();

    for start in 0..segs.len() {
        if used[start] {
            continue;
        }
        used[start] = true;
        let mut loop_pts: Vec<[f64; 2]> = vec![segs[start].0, segs[start].1];
        let mut end = segs[start].1;
        let mut closed = false;
        loop {
            let first = loop_pts[0];
            if near(end, first) {
                closed = true;
                break;
            }
            // Find an unused segment sharing the current end (either orientation).
            let mut found = false;
            for (i, seg) in segs.iter().enumerate() {
                if used[i] {
                    continue;
                }
                if near(seg.0, end) {
                    used[i] = true;
                    end = seg.1;
                    loop_pts.push(end);
                    found = true;
                    break;
                } else if near(seg.1, end) {
                    used[i] = true;
                    end = seg.0;
                    loop_pts.push(end);
                    found = true;
                    break;
                }
            }
            if !found {
                break; // open chain — keep what we have
            }
        }
        // Drop the duplicate closing point if present.
        if loop_pts.len() >= 2 && near(*loop_pts.last().unwrap(), loop_pts[0]) {
            loop_pts.pop();
        }
        if loop_pts.len() >= 3 {
            loops.push((loop_pts, closed));
        }
    }

    // Largest-area loop first = the board perimeter; the rest are inner cutouts.
    loops.sort_by(|a, b| {
        ring_area(&b.0)
            .abs()
            .partial_cmp(&ring_area(&a.0).abs())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    loops
}

/// Signed area (shoelace) of a ring.
fn ring_area(ring: &[[f64; 2]]) -> f64 {
    let n = ring.len();
    let mut s = 0.0;
    for i in 0..n {
        let a = ring[i];
        let b = ring[(i + 1) % n];
        s += a[0] * b[1] - b[0] * a[1];
    }
    s / 2.0
}

/// Build the FR4 substrate: top + bottom faces (drilled through) and the
/// perimeter + inner-cutout walls. Drill bores get copper barrels instead of
/// FR4 walls (added per drill layer), so they don't z-fight.
#[tracing::instrument(skip_all, fields(loops = loops.len(), holes = holes.len()))]
fn build_substrate(loops: &[Vec<[f64; 2]>], holes: &[Hole]) -> Buffer {
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
                emit_face(&mut buf, &data, &tris, FR4_THICK, 1.0); // top face
                emit_face(&mut buf, &data, &tris, 0.0, -1.0); // bottom face
            }
        }
    }
    // Walls only for the perimeter + inner cutouts (NOT drills).
    add_wall(&mut buf, &loops[0], 0.0, FR4_THICK);
    for inner in &loops[1..] {
        add_wall(&mut buf, inner, 0.0, FR4_THICK);
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
            geometry::mask_polygons(outline, layer.bytes).ok()?
        } else {
            geometry::layer_polygons(layer.bytes, holes).ok()?
        }
    };
    if polys.is_empty() {
        return None;
    }
    let z = z_for(layer.role, layer.side);
    let nz = if matches!(layer.side, Side::Bottom) {
        -1.0
    } else {
        1.0
    };
    let mut buf = Buffer::default();
    {
        let _span = tracing::info_span!("triangulate", polys = polys.len()).entered();
        for p in &polys {
            add_poly(&mut buf, p, z, nz);
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
#[tracing::instrument(skip_all, fields(layers = layers.len()))]
pub fn board_geometry(layers: &[LayerInput]) -> BoardMesh {
    // 1. Collect ALL drill holes (used to drill the substrate faces and cut fills).
    let mut holes: Vec<Hole> = Vec::new();
    {
        let _span = tracing::info_span!("collect_holes").entered();
        for l in layers {
            if l.role == Role::Drill {
                if let Ok(hs) = crate::drill::parse_drill(l.bytes) {
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

    // 3. Substrate.
    let substrate = build_substrate(&outline, &holes);

    // 4. Surface layers, triangulated in parallel (the heavy part).
    let mut meshes: Vec<LayerMesh> = {
        let _span = tracing::info_span!("triangulate_parallel").entered();
        // Capture the current span so each layer's spans (created on rayon
        // workers) stay its children and route to this operation's trace file.
        let dh = crate::trace::capture_dispatch();
        layers
            .par_iter()
            .filter_map(|l| dh.run(|| build_surface_layer(l, &holes, &outline)))
            .collect()
    };

    // 5. One barrel mesh per drill layer (keyed by that layer, so it toggles).
    {
        let _span = tracing::info_span!("barrels").entered();
        for l in layers {
            if l.role != Role::Drill {
                continue;
            }
            let Ok(hs) = crate::drill::parse_drill(l.bytes) else {
                continue;
            };
            let mut buf = Buffer::default();
            for h in &hs {
                if h.d_mm > 0.0 {
                    add_barrel(&mut buf, h.x_mm, h.y_mm, h.d_mm / 2.0, 0.0, FR4_THICK);
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

#[cfg(test)]
mod tests {
    use super::*;

    const FLASH_PAD: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,4.0*%\nD10*\nX0Y0D03*\nM02*\n";
    // A simple rectangular Edge_Cuts outline (4 stroked sides), 10x10 mm.
    const EDGE_SQUARE: &[u8] = b"%FSLAX24Y24*%\n%MOMM*%\n%ADD10C,0.1*%\nD10*\nX0Y0D02*\nX0100000Y0D01*\nX0100000Y0100000D01*\nX0Y0100000D01*\nX0Y0D01*\nM02*\n";

    #[test]
    fn copper_layer_triangulates_to_nonempty_buffer() {
        let layers = vec![LayerInput {
            key: "cu".into(),
            role: Role::Copper,
            side: Side::Top,
            bytes: FLASH_PAD,
        }];
        let board = board_geometry(&layers);
        assert_eq!(board.layers.len(), 1);
        let m = &board.layers[0];
        assert_eq!(m.kind, KIND_COPPER);
        assert!(
            !m.buffer.positions.is_empty(),
            "copper buffer should have verts"
        );
        assert!(
            !m.buffer.indices.is_empty(),
            "copper buffer should have indices"
        );
        assert_eq!(
            m.buffer.positions.len(),
            m.buffer.normals.len(),
            "pos/normal parity"
        );
    }

    #[test]
    fn edge_outline_builds_substrate_faces_and_walls() {
        let layers = vec![LayerInput {
            key: "edge".into(),
            role: Role::Edge,
            side: Side::Both,
            bytes: EDGE_SQUARE,
        }];
        let board = board_geometry(&layers);
        assert!(
            !board.substrate.positions.is_empty(),
            "substrate should be built from the outline"
        );
        assert!(!board.substrate.indices.is_empty());
    }

    #[test]
    fn drill_layer_emits_a_barrel_mesh() {
        // One PTH drill: a 0.3 mm hole at (5,5).
        const DRL: &[u8] = b"M48\nMETRIC,TZ\nT1C0.300\n%\nT1\nX5.0Y5.0\nM30\n";
        let layers = vec![LayerInput {
            key: "drl".into(),
            role: Role::Drill,
            side: Side::Both,
            bytes: DRL,
        }];
        let board = board_geometry(&layers);
        let barrels: Vec<_> = board
            .layers
            .iter()
            .filter(|m| m.kind == KIND_BARREL)
            .collect();
        assert_eq!(
            barrels.len(),
            1,
            "expected one barrel mesh for the drill layer"
        );
        assert!(
            !barrels[0].buffer.positions.is_empty(),
            "barrel should have wall verts"
        );
    }

    #[test]
    fn two_faces_share_xy_and_reverse_winding() {
        // The substrate top/bottom optimization triangulates once and emits two
        // faces. Verify both faces have identical XY (differ only in Z) and the
        // bottom face's winding is reversed — i.e. bit-identical to two add_poly
        // calls with (z, +1) then (z, -1).
        let poly = Poly {
            outer: vec![[0.0, 0.0], [4.0, 0.0], [4.0, 4.0], [0.0, 4.0]],
            holes: vec![],
        };
        let (data, tris) = triangulate_poly(&poly).expect("square triangulates");
        let mut buf = Buffer::default();
        emit_face(&mut buf, &data, &tris, FR4_THICK, 1.0);
        let vert_n = data.len() / 2;
        emit_face(&mut buf, &data, &tris, 0.0, -1.0);

        // Two faces' worth of verts and indices.
        assert_eq!(buf.positions.len(), vert_n * 3 * 2, "two faces of verts");
        assert_eq!(buf.indices.len(), tris.len() * 2, "two faces of tris");
        // Top verts at z=FR4_THICK, bottom at z=0, same XY.
        for i in 0..vert_n {
            let top = i * 3;
            let bot = (vert_n + i) * 3;
            assert_eq!(buf.positions[top], buf.positions[bot], "x matches");
            assert_eq!(buf.positions[top + 1], buf.positions[bot + 1], "y matches");
            assert_eq!(buf.positions[top + 2], FR4_THICK, "top z");
            assert_eq!(buf.positions[bot + 2], 0.0, "bottom z");
        }
        // Bottom winding (a, c, b) is the reverse of top (a, b, c), offset by vert_n.
        let tri_n = tris.len() / 3;
        for t in 0..tri_n {
            let top = &buf.indices[t * 3..t * 3 + 3];
            let bot = &buf.indices[(tri_n + t) * 3..(tri_n + t) * 3 + 3];
            assert_eq!(bot[0], top[0] + vert_n as u32, "bottom a = top a + offset");
            assert_eq!(bot[1], top[2] + vert_n as u32, "bottom swaps b/c (c)");
            assert_eq!(bot[2], top[1] + vert_n as u32, "bottom swaps b/c (b)");
        }
    }

    #[test]
    fn board_geometry_emits_phase_spans_to_trace() {
        // A board exercising every phase: copper surface, edge outline, a drill.
        const DRL: &[u8] = b"M48\nMETRIC,TZ\nT1C0.300\n%\nT1\nX5.0Y5.0\nM30\n";
        let layers = vec![
            LayerInput {
                key: "cu".into(),
                role: Role::Copper,
                side: Side::Top,
                bytes: FLASH_PAD,
            },
            LayerInput {
                key: "edge".into(),
                role: Role::Edge,
                side: Side::Both,
                bytes: EDGE_SQUARE,
            },
            LayerInput {
                key: "drl".into(),
                role: Role::Drill,
                side: Side::Both,
                bytes: DRL,
            },
        ];

        let tmp = std::env::temp_dir().join(format!("cuprum-mesh-trace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let cfg = crate::trace::TraceConfig::Dir(tmp.clone());
        let board = crate::trace::run_with_config(&cfg, "mesh", &tmp, || board_geometry(&layers));
        assert!(!board.substrate.positions.is_empty(), "board still built");

        let file = std::fs::read_dir(&tmp)
            .expect("trace dir exists")
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.extension().map(|x| x == "json").unwrap_or(false))
            .expect("a mesh trace file was written");
        let body = std::fs::read_to_string(&file).unwrap();
        serde_json::from_str::<serde_json::Value>(&body).expect("trace is valid JSON");

        // Main-thread phase spans + substrate sub-phases.
        for name in [
            "collect_holes",
            "outline",
            "build_substrate",
            "drill_faces",
            "triangulate_faces",
            "triangulate_parallel",
            "barrels",
        ] {
            assert!(
                body.contains(name),
                "phase span `{name}` missing from trace"
            );
        }
        // Per-layer spans run on rayon workers; their presence proves the
        // `capture_dispatch`/`dh.run` propagation routes worker spans to the file.
        for name in ["build_surface_layer", "polygons", "triangulate"] {
            assert!(
                body.contains(name),
                "worker span `{name}` missing — dispatch propagation broken"
            );
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn stitch_closes_a_square() {
        let segs = vec![
            ([0.0, 0.0], [10.0, 0.0]),
            ([10.0, 0.0], [10.0, 10.0]),
            ([10.0, 10.0], [0.0, 10.0]),
            ([0.0, 10.0], [0.0, 0.0]),
        ];
        let loops = stitch(segs);
        assert_eq!(loops.len(), 1, "four sides should stitch into one loop");
        assert_eq!(
            loops[0].0.len(),
            4,
            "square has 4 unique corners: {:?}",
            loops[0].0
        );
        assert!(loops[0].1, "a square should be detected as a closed loop");
    }
}
