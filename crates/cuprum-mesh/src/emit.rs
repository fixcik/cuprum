//! Triangle-buffer emit primitives: earcut a polygon once, emit flat faces,
//! vertical walls and drill-bore barrels into a [`Buffer`](super::Buffer).

use std::f64::consts::TAU;

use cuprum_gerber::geometry::Poly;

use super::{Buffer, BARREL_SEGS};

/// Earcut a polygon (outer ring + holes) once, returning the flattened XY vertex
/// data and the triangle index list — both reusable across multiple faces of the
/// SAME 2D shape (e.g. the substrate's top + bottom). `None` if degenerate.
/// Robust for SIMPLE polygons, which is what `geometry` produces after the
/// boolean union/difference.
pub(crate) fn triangulate_poly(poly: &Poly) -> Option<(Vec<f64>, Vec<usize>)> {
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
pub(crate) fn emit_face(buf: &mut Buffer, data: &[f64], tris: &[usize], z: f32, nz: f32) {
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

/// Extrude a polygon into a closed slab between `z0` (bottom) and `z1` (top): a
/// top face (up), a bottom face (down) and vertical walls around the outer ring
/// and every hole. Gives surface layers real volume so they read as solid
/// material sitting on the board instead of planes floating at grazing angles.
pub(crate) fn add_slab(buf: &mut Buffer, poly: &Poly, z0: f32, z1: f32) {
    let Some((data, tris)) = triangulate_poly(poly) else {
        return;
    };
    emit_face(buf, &data, &tris, z1, 1.0); // top, up
    emit_face(buf, &data, &tris, z0, -1.0); // bottom, down
    add_wall(buf, &ring_f64(&poly.outer), z0, z1);
    for hole in &poly.holes {
        add_wall(buf, &ring_f64(hole), z0, z1);
    }
}

/// Widen a polygon ring's `[f32; 2]` vertices to the `[f64; 2]` that [`add_wall`]
/// consumes.
fn ring_f64(ring: &[[f32; 2]]) -> Vec<[f64; 2]> {
    ring.iter().map(|p| [p[0] as f64, p[1] as f64]).collect()
}

/// Add a vertical wall along a closed ring, from `z0` up to `z1`, with outward
/// horizontal normals. For a CCW ring the normal `(dy, -dx)` points outward.
pub(crate) fn add_wall(buf: &mut Buffer, ring: &[[f64; 2]], z0: f32, z1: f32) {
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
pub(crate) fn add_barrel(buf: &mut Buffer, cx: f32, cy: f32, r: f32, z0: f32, z1: f32) {
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
