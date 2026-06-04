//! Edge_Cuts outline: extract centreline segments from the edge gerber and
//! stitch them into closed loops (perimeter first, then inner cutouts).

use gerber_viewer::GerberPrimitive;

use super::{EDGE_ARC_STEPS, STITCH_EPS};

/// Edge_Cuts CENTERLINE segments (Line/Arc, arcs tessellated). Flashed cap
/// circles / fills are ignored — they're not part of the cut path.
fn edge_segments(edge_bytes: &[u8]) -> Vec<([f64; 2], [f64; 2])> {
    // Shared cross-operation parse: metrics/mesh/SVG reuse one parsed layer.
    let layer = match cuprum_gerber::gerber::parse_layer_cached(edge_bytes) {
        Ok(l) => l,
        Err(_) => return Vec::new(),
    };
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
pub fn outline_info(edge_bytes: &[u8]) -> (Vec<Vec<[f64; 2]>>, bool) {
    let loops = stitch(edge_segments(edge_bytes));
    let perimeter_closed = loops.first().map(|(_, closed)| *closed).unwrap_or(false);
    (
        loops.into_iter().map(|(ring, _)| ring).collect(),
        perimeter_closed,
    )
}

/// Edge_Cuts outline loops only (perimeter first, then inner cutouts).
pub(crate) fn outline_loops(edge_bytes: &[u8]) -> Vec<Vec<[f64; 2]>> {
    outline_info(edge_bytes).0
}

/// Stitch a soup of segments into closed loops by matching endpoints (greedy),
/// returning each loop with a flag for whether it actually closed (vs an open
/// chain that ran out of matching segments). Edge_Cuts is tiny (a handful of
/// segments), so O(n²) chaining is fine.
pub(crate) fn stitch(segs: Vec<([f64; 2], [f64; 2])>) -> Vec<(Vec<[f64; 2]>, bool)> {
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
