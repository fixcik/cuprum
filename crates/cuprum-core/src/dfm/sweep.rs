//! DFM sweep: the clearance/width hotspot scan over copper polygons and the
//! geometric helpers it needs. Pure measurement — depends on `crate::geometry`
//! for polygon types and shared primitives, never the reverse.

use crate::geometry::{point_in_ring, point_seg_closest, poly_containing, Poly};
use rayon::prelude::*;

/// Grid resolution for the nearest-edge sweep: cell ≈ board_diag / this.
const DIST_CELLS: f64 = 220.0;
/// Safety cap on segment-pair comparisons (real boards stay well under it).
const DIST_BUDGET: u64 = 120_000_000;

fn orient(a: [f64; 2], b: [f64; 2], c: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

/// Do segments `ab` and `cd` properly cross? (Distance 0 when they do.)
fn segs_cross(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> bool {
    let (d1, d2, d3, d4) = (
        orient(c, d, a),
        orient(c, d, b),
        orient(a, b, c),
        orient(a, b, d),
    );
    ((d1 > 0.0) != (d2 > 0.0)) && ((d3 > 0.0) != (d4 > 0.0))
}

/// Proper intersection point of segments `ab` and `cd`, if they cross.
#[inline]
fn segs_intersection(a: [f64; 2], b: [f64; 2], c: [f64; 2], d: [f64; 2]) -> Option<[f64; 2]> {
    if !segs_cross(a, b, c, d) {
        return None;
    }
    let r = [b[0] - a[0], b[1] - a[1]];
    let s = [d[0] - c[0], d[1] - c[1]];
    let rxs = r[0] * s[1] - r[1] * s[0];
    if rxs.abs() < 1e-12 {
        return None;
    }
    let t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / rxs;
    Some([a[0] + t * r[0], a[1] + t * r[1]])
}

/// The two closest points (one on each segment) and their distance.
#[inline]
fn seg_seg_closest(
    a: [f64; 2],
    b: [f64; 2],
    c: [f64; 2],
    d: [f64; 2],
) -> ([f64; 2], [f64; 2], f64) {
    if let Some(x) = segs_intersection(a, b, c, d) {
        return (x, x, 0.0);
    }
    // Parallel + overlapping projection: the closest pair is a whole interval,
    // and the naive 4-endpoint scan below picks a CORNER of it. Return the MIDDLE
    // of the overlap instead — geometrically the representative point of a neck or
    // gap (so its midpoint lands in copper / in the void, which the neck/bay
    // filter relies on), and where a marker should sit.
    let r = [b[0] - a[0], b[1] - a[1]];
    let s = [d[0] - c[0], d[1] - c[1]];
    let len2 = r[0] * r[0] + r[1] * r[1];
    let cross = r[0] * s[1] - r[1] * s[0];
    let slen = (s[0] * s[0] + s[1] * s[1]).sqrt();
    if len2 > 1e-18 && cross.abs() <= 1e-7 * len2.sqrt() * slen {
        let tc = ((c[0] - a[0]) * r[0] + (c[1] - a[1]) * r[1]) / len2;
        let td = ((d[0] - a[0]) * r[0] + (d[1] - a[1]) * r[1]) / len2;
        let lo = tc.min(td).max(0.0);
        let hi = tc.max(td).min(1.0);
        if lo <= hi {
            let tm = (lo + hi) / 2.0;
            let pab = [a[0] + tm * r[0], a[1] + tm * r[1]];
            let (pcd, dist) = point_seg_closest(pab, c, d);
            return (pab, pcd, dist);
        }
    }
    let (q1, d1) = point_seg_closest(c, a, b);
    let (q2, d2) = point_seg_closest(d, a, b);
    let (q3, d3) = point_seg_closest(a, c, d);
    let (q4, d4) = point_seg_closest(b, c, d);
    let mut best = (q1, c, d1);
    if d2 < best.2 {
        best = (q2, d, d2);
    }
    if d3 < best.2 {
        best = (a, q3, d3);
    }
    if d4 < best.2 {
        best = (b, q4, d4);
    }
    best
}

/// One boundary edge, tagged for cross-polygon vs same-ring-adjacency tests.
struct GEdge {
    a: [f64; 2],
    b: [f64; 2],
    poly: u32,
    ring: u32,
    idx: u32,
    n: u32,
}

/// Max deviation (mm) at which a vertex is treated as polygon noise and dropped
/// before the clearance/width sweep. Well under the artefact floor (50 µm), so
/// only sub-resolution tessellation/boolean-op noise is removed — never a real
/// feature.
const SIMPLIFY_TOL_MM: f64 = 0.01;

/// Minimum length (mm) of BOTH edges bounding a clearance/width hotspot. A real
/// thin gap or copper neck runs at least this far; a point-notch from aperture-
/// macro / tessellation seams is bounded by a tiny chord (~the arc segment),
/// which falls below this and is rejected. (Persistence / minimum-extent filter.)
const MIN_FEATURE_EDGE: f64 = 0.12;

/// Max cosine between the two bounding edges' DIRECTIONS for a copper-width
/// hotspot to count as a real neck. A genuine neck/trace is bounded by two faces
/// running OPPOSITE ways (cos ≈ −1). A wedge at a trace bend/junction or a
/// rounded-pad arc has faces meeting at an acute angle (cos ≳ −0.5) — the small
/// cross-distance there is geometry, not a thin trace. Require cos ≤ this.
const NECK_ANTIPARALLEL_COS_MAX: f64 = -0.5;

/// Persistence filter for copper-width necks. A real thin neck / sliver is a
/// CORRIDOR: the narrow width ≈`d` extends along the channel for a length
/// comparable to `d`. A trace BEND (two segments + round caps unioned) reads as
/// a thin cross-distance at the concave seam, but that narrowness is point-like —
/// step along the channel axis and the copper widens or ends at once.
///
/// `NECK_WIDTH_GROW`: how much the local width may grow and still count as the
/// same channel. `MIN_NECK_LEN = max(d·FACTOR, FLOOR)`: required channel extent
/// (summed over both directions from the span midpoint) to flag as a neck.
const NECK_WIDTH_GROW: f64 = 1.75;
const MIN_NECK_LEN_FACTOR: f64 = 2.0;
const MIN_NECK_LEN_FLOOR: f64 = 0.15;

/// Drop polygon noise from a ring before the nearest-edge sweep: near-duplicate
/// and near-collinear vertices. Such a vertex never represents a real DFM
/// feature (a thin neck is two SEPARATE edges close together, not one vertex
/// sitting on its neighbours' line), but it spawns phantom hotspots — e.g.
/// tessellation noise along a curved board edge turns non-adjacent micro-edges
/// into a false "thin copper" reading. Removing it shortens index distances so
/// genuinely-adjacent boundary stops being measured against itself.
fn simplify_ring(ring: &[[f32; 2]]) -> Vec<[f32; 2]> {
    let tol = SIMPLIFY_TOL_MM;
    let f = |p: [f32; 2]| [p[0] as f64, p[1] as f64];
    // 1) Collapse consecutive near-duplicate points.
    let mut pts: Vec<[f32; 2]> = Vec::with_capacity(ring.len());
    for &p in ring {
        if let Some(&last) = pts.last() {
            let (a, b) = (f(last), f(p));
            if (a[0] - b[0]).hypot(a[1] - b[1]) < tol {
                continue;
            }
        }
        pts.push(p);
    }
    // Drop a trailing point coincident with the first (rings may or may not repeat it).
    while pts.len() > 1 {
        let (a, b) = (f(pts[0]), f(*pts.last().unwrap()));
        if (a[0] - b[0]).hypot(a[1] - b[1]) < tol {
            pts.pop();
        } else {
            break;
        }
    }
    // 2) Iteratively drop near-collinear vertices (perp distance to the segment
    //    between kept neighbours < tol). Skip the vertex after a removal so two
    //    adjacent vertices aren't dropped in the same pass (bounds drift).
    loop {
        let m = pts.len();
        if m <= 3 {
            break;
        }
        let mut keep = vec![true; m];
        let mut removed = 0usize;
        let mut i = 0;
        while i < m {
            let prev = (i + m - 1) % m;
            let next = (i + 1) % m;
            if keep[prev] && keep[next] {
                let (_, d) = point_seg_closest(f(pts[i]), f(pts[prev]), f(pts[next]));
                if d < tol {
                    keep[i] = false;
                    removed += 1;
                    i += 2;
                    continue;
                }
            }
            i += 1;
        }
        if removed == 0 {
            break;
        }
        pts = (0..m).filter(|&i| keep[i]).map(|i| pts[i]).collect();
    }
    pts
}

fn collect_edges(polys: &[Poly]) -> Vec<GEdge> {
    let mut edges = Vec::new();
    for (pi, p) in polys.iter().enumerate() {
        // Simplify each ring first (kills phantom hotspots from tessellation /
        // boolean-op vertex noise; see `simplify_ring`).
        let outer = simplify_ring(&p.outer);
        let holes: Vec<Vec<[f32; 2]>> = p.holes.iter().map(|h| simplify_ring(h)).collect();
        let rings: Vec<&Vec<[f32; 2]>> = std::iter::once(&outer).chain(holes.iter()).collect();
        for (ri, ring) in rings.iter().enumerate() {
            let n = ring.len();
            if n < 2 {
                continue;
            }
            for i in 0..n {
                let a = ring[i];
                let b = ring[(i + 1) % n];
                edges.push(GEdge {
                    a: [a[0] as f64, a[1] as f64],
                    b: [b[0] as f64, b[1] as f64],
                    poly: pi as u32,
                    ring: ri as u32,
                    idx: i as u32,
                    n: n as u32,
                });
            }
        }
    }
    edges
}

/// Two edges of the same ring that share a vertex (consecutive, cyclic).
#[inline]
fn adjacent(x: &GEdge, y: &GEdge) -> bool {
    if x.poly != y.poly || x.ring != y.ring {
        return false;
    }
    let d = x.idx.abs_diff(y.idx);
    d <= 1 || d == x.n - 1
}

/// A geometric DFM hotspot: the two closest mm points and the measured distance
/// between them (the value to annotate, e.g. the gap or copper width).
pub type Hot = ([f64; 2], [f64; 2], f64);

/// Max hotspots reported per metric (worst-first); excess is dropped.
const HOT_N: usize = 40;
/// Merge hotspots whose midpoints fall in the same ~1 mm cell (so a long thin
/// gap doesn't become dozens of near-identical entries).
const HOT_DEDUP_MM: f64 = 1.0;
/// Safety cap on collected candidates before dedup.
const HOT_COLLECT_CAP: usize = 200_000;

/// Spatially dedupe (keep the worst per ~1 mm cell), sort worst-first, cap to N.
fn dedup_top(hots: Vec<Hot>) -> Vec<Hot> {
    let mut best: std::collections::HashMap<(i64, i64), Hot> = std::collections::HashMap::new();
    for h in hots {
        let mx = ((h.0[0] + h.1[0]) / 2.0 / HOT_DEDUP_MM).round() as i64;
        let my = ((h.0[1] + h.1[1]) / 2.0 / HOT_DEDUP_MM).round() as i64;
        best.entry((mx, my))
            .and_modify(|b| {
                if h.2 < b.2 {
                    *b = h;
                }
            })
            .or_insert(h);
    }
    let mut v: Vec<Hot> = best.into_values().collect();
    // Worst-first by distance, then a coordinate tie-break so the order (and thus
    // the truncated top-N set) is fully deterministic — independent of the HashMap
    // iteration order above. Equal distances are common on real boards (uniform pad
    // pitch, parallel traces); without the tie-break the result varies per run and
    // per thread, which would break the disk cache and the parallel/sequential
    // equivalence the metrics path relies on.
    v.sort_by(|a, b| {
        a.2.partial_cmp(&b.2)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.0[0].total_cmp(&b.0[0]))
            .then(a.0[1].total_cmp(&b.0[1]))
            .then(a.1[0].total_cmp(&b.1[0]))
            .then(a.1[1].total_cmp(&b.1[1]))
    });
    v.truncate(HOT_N);
    v
}

/// Nearest-edge sweep over a uniform grid, returning the worst hotspots for
/// (clearance between DISTINCT polygons, copper width = distance between
/// non-adjacent edges of the SAME polygon). Each hotspot carries the two closest
/// mm points + the distance. Only DRC-relevant gaps (≲ 2 cells ≈ diag/110) are
/// collected; the frontend filters by the profile threshold. One pass feeds both.
/// Which side(s) of the clearance/width sweep to compute. Each caller uses only
/// one: the full-union path needs Clearance, the region path needs Width. Skipping
/// the other side avoids its per-pair work — crucially the O(ring) `point_in_ring`
/// interiorness test of the width branch, which on a dense full-union pour
/// dominated the sweep (~1.5 s of a ~1.9 s call) and was then discarded.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Want {
    Clearance,
    Width,
    Both,
}

/// Target edges per sweep chunk in the auto path. Small enough that the heaviest
/// (lowest-ei) chunk is a thin slice: each edge scans only `ej > ei`, so low-ei
/// edges carry far more work — fine chunks let rayon work-stealing flatten that
/// triangular load. Bigger = fewer tasks; smaller = finer balance.
const TARGET_CHUNK_EDGES: usize = 512;
/// Upper bound on the auto chunk count, capping task/merge overhead on huge boards.
const MAX_SWEEP_CHUNKS: usize = 256;

fn hotspots(polys: &[Poly], want: Want) -> (Vec<Hot>, Vec<Hot>) {
    hotspots_chunked(polys, want, None)
}

#[tracing::instrument(skip_all, fields(polys = polys.len()))]
fn hotspots_chunked(polys: &[Poly], want: Want, nchunks: Option<usize>) -> (Vec<Hot>, Vec<Hot>) {
    let edges = collect_edges(polys);
    if edges.len() < 2 {
        return (Vec::new(), Vec::new());
    }
    let (mut minx, mut miny, mut maxx, mut maxy) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
    for e in &edges {
        for p in [e.a, e.b] {
            minx = minx.min(p[0]);
            miny = miny.min(p[1]);
            maxx = maxx.max(p[0]);
            maxy = maxy.max(p[1]);
        }
    }
    let diag = (maxx - minx).hypot(maxy - miny).max(1e-6);
    let cell = (diag / DIST_CELLS).clamp(0.2, 10.0);
    // Cell index along each axis. `x >= minx` so indices are >= 0. `nx`/`ny` are
    // sized to the max index inclusive, so every edge cell is in range.
    let key =
        |x: f64, y: f64| -> (i64, i64) { (((x - minx) / cell) as i64, ((y - miny) / cell) as i64) };
    let nx = (((maxx - minx) / cell) as i64 + 1).max(1);
    let ny = (((maxy - miny) / cell) as i64 + 1).max(1);
    // Flat grid: `Vec<Vec<usize>>` indexed by `gy * nx + gx` — no hashing in the
    // hot loop. Same cells, same insertion order → identical buckets to the old
    // HashMap, hence bit-identical sweep results.
    let cell_at = |gx: i64, gy: i64| -> usize { (gy * nx + gx) as usize };
    let mut grid: Vec<Vec<usize>> = vec![Vec::new(); (nx * ny) as usize];
    {
        let _gb = tracing::info_span!("grid_build", edges = edges.len()).entered();
        for (ei, e) in edges.iter().enumerate() {
            let (cx0, cy0) = key(e.a[0].min(e.b[0]), e.a[1].min(e.b[1]));
            let (cx1, cy1) = key(e.a[0].max(e.b[0]), e.a[1].max(e.b[1]));
            // Clamp the high index (a coordinate exactly at max maps to nx/ny).
            let cx1 = cx1.min(nx - 1);
            let cy1 = cy1.min(ny - 1);
            for gx in cx0..=cx1 {
                for gy in cy0..=cy1 {
                    grid[cell_at(gx, gy)].push(ei);
                }
            }
        }
    }

    let max_gap = cell * 2.0; // matches the ±2-cell neighbour search radius

    // One contiguous ei-range, swept in ascending order against the shared grid,
    // into LOCAL output in serial push order. `visited`/`visit_gen` are supplied by
    // the caller and REUSED across the chunks one worker handles (see `map_init`
    // below): `visit_gen` increments once per `ei` and is never reset, so a stamp
    // equal to the current gen is unique to this edge's scan regardless of chunk
    // boundaries — stale stamps from a prior chunk carry a smaller gen. `budget`
    // stays per-range (pathological-blowup backstop, never reached on real boards).
    // Concatenating ranges in order reproduces the exact serial push sequence — see
    // `chunked_sweep_matches_serial`.
    let sweep_range = |range: std::ops::Range<usize>,
                       visited: &mut [u32],
                       visit_gen: &mut u32|
     -> (Vec<Hot>, Vec<Hot>) {
        let (mut clear, mut width): (Vec<Hot>, Vec<Hot>) = (Vec::new(), Vec::new());
        let mut budget = DIST_BUDGET;
        'sweep: for ei in range {
            let e = &edges[ei];
            *visit_gen += 1;
            let gen = *visit_gen;
            let (cx0, cy0) = key(e.a[0].min(e.b[0]), e.a[1].min(e.b[1]));
            let (cx1, cy1) = key(e.a[0].max(e.b[0]), e.a[1].max(e.b[1]));
            let gx_lo = (cx0 - 2).max(0);
            let gx_hi = (cx1 + 2).min(nx - 1);
            let gy_lo = (cy0 - 2).max(0);
            let gy_hi = (cy1 + 2).min(ny - 1);
            for gx in gx_lo..=gx_hi {
                for gy in gy_lo..=gy_hi {
                    let bucket = &grid[cell_at(gx, gy)];
                    for &ej in bucket {
                        if ej <= ei || visited[ej] == gen {
                            continue;
                        }
                        visited[ej] = gen;
                        let f = &edges[ej];
                        let cross = e.poly != f.poly;
                        let want_this = match want {
                            Want::Clearance => cross,
                            Want::Width => !cross && !adjacent(e, f),
                            Want::Both => cross || !adjacent(e, f),
                        };
                        if !want_this {
                            continue;
                        }
                        if budget == 0 {
                            break 'sweep;
                        }
                        budget -= 1;
                        let (pa, pb, d) = seg_seg_closest(e.a, e.b, f.a, f.b);
                        if d > max_gap {
                            continue;
                        }
                        let el = (e.a[0] - e.b[0]).hypot(e.a[1] - e.b[1]);
                        let fl = (f.a[0] - f.b[0]).hypot(f.a[1] - f.b[1]);
                        if el.min(fl) < MIN_FEATURE_EDGE {
                            continue;
                        }
                        if cross {
                            if clear.len() < HOT_COLLECT_CAP {
                                clear.push((pa, pb, d));
                            }
                        } else {
                            let de = [e.b[0] - e.a[0], e.b[1] - e.a[1]];
                            let df = [f.b[0] - f.a[0], f.b[1] - f.a[1]];
                            let (le2, lf2) = (de[0].hypot(de[1]), df[0].hypot(df[1]));
                            let cos = if le2 > 1e-9 && lf2 > 1e-9 {
                                (de[0] * df[0] + de[1] * df[1]) / (le2 * lf2)
                            } else {
                                0.0
                            };
                            if cos > NECK_ANTIPARALLEL_COS_MAX {
                                continue;
                            }
                            let mid = [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0];
                            let poly = &polys[e.poly as usize];
                            let inside = point_in_ring(mid, &poly.outer)
                                && !poly.holes.iter().any(|h| point_in_ring(mid, h));
                            if !inside {
                                continue;
                            }
                            if width.len() < HOT_COLLECT_CAP {
                                width.push((pa, pb, d));
                            }
                        }
                    }
                }
            }
        }
        (clear, width)
    };

    // Split [0, n) into contiguous ei-chunks, sweep them in parallel, merge in
    // chunk order → identical push sequence to a single serial pass. `dedup_top`
    // is order-deterministic, and `HOT_COLLECT_CAP` truncation on the merged (in-
    // order) sequence keeps the same first-N as serial.
    let n = edges.len();
    let nchunks = nchunks
        .unwrap_or_else(|| {
            (n / TARGET_CHUNK_EDGES).clamp(rayon::current_num_threads(), MAX_SWEEP_CHUNKS)
        })
        .clamp(1, n.max(1));
    let chunk = n.div_ceil(nchunks).max(1);
    let ranges: Vec<std::ops::Range<usize>> = (0..n)
        .step_by(chunk)
        .map(|s| s..(s + chunk).min(n))
        .collect();
    let _sw = tracing::info_span!("sweep", edges = n, chunks = ranges.len()).entered();
    let parts: Vec<(Vec<Hot>, Vec<Hot>)> = {
        let dh = crate::trace::capture_dispatch();
        ranges
            .into_par_iter()
            .map_init(
                // One (visited, gen) buffer per rayon worker for this call, reused
                // across the chunks that worker handles — no per-chunk allocation.
                || (vec![0u32; n], 0u32),
                |(visited, visit_gen), r| dh.run(|| sweep_range(r, visited, visit_gen)),
            )
            .collect()
    };
    let (mut clear, mut width): (Vec<Hot>, Vec<Hot>) = (Vec::new(), Vec::new());
    for (c, w) in parts {
        clear.extend(c);
        width.extend(w);
    }
    clear.truncate(HOT_COLLECT_CAP);
    width.truncate(HOT_COLLECT_CAP);
    drop(_sw);
    // Persistence filter (drops trace-bend / pad-seam false necks) is O(edges)
    // per candidate, so run it ONLY on the final reported set — never in the hot
    // sweep above (a dense pour yields tens of thousands of candidates). Each
    // surviving hotspot's island is found by midpoint containment.
    let width = {
        let _wf = tracing::info_span!("width_filter").entered();
        dedup_top(width)
            .into_iter()
            .filter(|&(pa, pb, d)| {
                let mid = [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0];
                poly_containing(polys, mid).is_none_or(|poly| neck_persists(poly, pa, pb, d))
            })
            .collect()
    };
    (dedup_top(clear), width)
}

/// Nearest distance from `origin` along unit `dir` to any boundary edge of
/// `poly` (outer ring + holes). `INFINITY` if the ray hits nothing. Used to
/// measure the local copper width across a candidate neck.
fn ray_boundary_dist(poly: &Poly, origin: [f64; 2], dir: [f64; 2]) -> f64 {
    let cross = |v: [f64; 2], w: [f64; 2]| v[0] * w[1] - v[1] * w[0];
    let mut best = f64::INFINITY;
    let rings = std::iter::once(&poly.outer).chain(poly.holes.iter());
    for ring in rings {
        let n = ring.len();
        if n < 2 {
            continue;
        }
        for i in 0..n {
            let a = [ring[i][0] as f64, ring[i][1] as f64];
            let b = [ring[(i + 1) % n][0] as f64, ring[(i + 1) % n][1] as f64];
            let e = [b[0] - a[0], b[1] - a[1]];
            let denom = cross(dir, e);
            if denom.abs() < 1e-12 {
                continue; // ray parallel to edge
            }
            let ao = [a[0] - origin[0], a[1] - origin[1]];
            let t = cross(ao, e) / denom; // distance along the (unit) ray
            let u = cross(ao, dir) / denom; // position along the edge
            if t > 1e-9 && (0.0..=1.0).contains(&u) && t < best {
                best = t;
            }
        }
    }
    best
}

/// True if a candidate copper-width neck is a real CORRIDOR rather than a
/// point-like bend seam. Walks the channel axis (perpendicular to the span)
/// from the span midpoint in both directions; the neck persists if the copper
/// stays narrow (≤ `d·NECK_WIDTH_GROW`) and inside over a combined length of at
/// least `MIN_NECK_LEN`. See the `NECK_WIDTH_GROW` / `MIN_NECK_LEN_*` constants.
fn neck_persists(poly: &Poly, pa: [f64; 2], pb: [f64; 2], d: f64) -> bool {
    if d <= 1e-9 {
        return true;
    }
    let n = [(pb[0] - pa[0]) / d, (pb[1] - pa[1]) / d]; // across the channel
    let axis = [-n[1], n[0]]; // along the channel
    let m = [(pa[0] + pb[0]) / 2.0, (pa[1] + pb[1]) / 2.0];
    let inside = |p: [f64; 2]| {
        point_in_ring(p, &poly.outer) && !poly.holes.iter().any(|h| point_in_ring(p, h))
    };
    let step = (d * 0.5).clamp(0.02, 0.1);
    let target = (d * MIN_NECK_LEN_FACTOR).max(MIN_NECK_LEN_FLOOR);
    let width_cap = d * NECK_WIDTH_GROW;
    let max_probe = target + step;
    let mut extent = 0.0;
    for dir in [1.0_f64, -1.0] {
        let mut k = 1;
        loop {
            let off = dir * (k as f64) * step;
            if off.abs() > max_probe {
                break;
            }
            let s = [m[0] + off * axis[0], m[1] + off * axis[1]];
            if !inside(s) {
                break;
            }
            let w = ray_boundary_dist(poly, s, n) + ray_boundary_dist(poly, s, [-n[0], -n[1]]);
            if w > width_cap {
                break;
            }
            extent += step;
            if extent >= target {
                return true;
            }
            k += 1;
        }
    }
    extent >= target
}

/// (min clearance, min copper width) — the worst values, for the metrics tab.
pub fn min_clearance_and_width(polys: &[Poly]) -> (Option<f64>, Option<f64>) {
    let (c, w) = clearance_width_hotspots(polys);
    (c.first().map(|h| h.2), w.first().map(|h| h.2))
}

/// Both sides at once. Retained for `min_clearance_and_width` and the bit-identical
/// guard tests; hot callers use the one-sided `clearance_hotspots` / `width_hotspots`.
pub fn clearance_width_hotspots(polys: &[Poly]) -> (Vec<Hot>, Vec<Hot>) {
    hotspots(polys, Want::Both)
}

/// Clearance hotspots only (cross-polygon gaps) — e.g. the full copper union, mask
/// openings. Skips the copper-width branch entirely.
pub fn clearance_hotspots(polys: &[Poly]) -> Vec<Hot> {
    hotspots(polys, Want::Clearance).0
}

/// Copper-width (neck) hotspots only — e.g. the region copper set. Skips the
/// clearance branch entirely.
pub fn width_hotspots(polys: &[Poly]) -> Vec<Hot> {
    hotspots(polys, Want::Width).1
}

/// Min clearance between distinct polygons only (e.g. for mask openings).
pub fn min_island_clearance(polys: &[Poly]) -> Option<f64> {
    clearance_hotspots(polys).first().map(|h| h.2)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{layer_polygons, region_polygons};

    // Shared Gerber fixture: a 1 mm pad flash (D10/D03) plus a 0.1 mm trace draw
    // (D11/D01). Used by region_polygons_excludes_trace_strokes and the from-layer
    // equivalence tests below.
    const PAD_AND_TRACE: &[u8] = b"%FSLAX46Y46*%\n%MOMM*%\n\
        %ADD10C,1.0*%\n%ADD11C,0.1*%\n\
        D10*\nX0Y0D03*\n\
        D11*\nX0Y0D02*\nX5000000Y0D01*\nM02*\n";

    /// Collinear subdivisions and a duplicate vertex are polygon noise — the sweep
    /// pre-simplifies them away so a smooth/tessellated edge stops spawning phantom
    /// "thin copper" hotspots between its own micro-edges.
    #[test]
    fn simplify_drops_collinear_and_duplicate_noise() {
        let mut ring = vec![[0.0f32, 0.0]];
        for k in 1..20 {
            ring.push([k as f32 * 0.5, 0.0]); // 19 collinear points along the bottom edge
        }
        ring.push([10.0, 0.0]);
        ring.push([10.0, 0.0]); // exact duplicate
        ring.push([10.0, 10.0]);
        ring.push([0.0, 10.0]);
        let s = simplify_ring(&ring);
        assert!(
            s.len() <= 6,
            "collinear/duplicate noise collapsed to ~4 corners, got {}: {s:?}",
            s.len()
        );
    }

    /// Simplification must NOT erase a genuine thin feature: a 0.1 mm-wide copper
    /// rectangle still reports a copper-width hotspot ≈ 0.1 mm.
    #[test]
    fn simplify_keeps_a_real_thin_neck() {
        use crate::geometry::fill_polygons;
        let rect = vec![[0.0, 0.0], [5.0, 0.0], [5.0, 0.1], [0.0, 0.1]];
        let polys = fill_polygons(&[rect], &[]);
        let (_c, w) = clearance_width_hotspots(&polys);
        let mw = w.iter().map(|h| h.2).fold(f64::INFINITY, f64::min);
        assert!((mw - 0.1).abs() < 0.03, "thin copper width preserved: {mw}");
    }

    #[test]
    fn min_clearance_between_two_islands() {
        use crate::geometry::fill_polygons;
        // Two unit squares with a 0.2 mm gap in x → two disjoint polys.
        let a = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let b = vec![[1.2, 0.0], [2.2, 0.0], [2.2, 1.0], [1.2, 1.0]];
        let polys = fill_polygons(&[a, b], &[]);
        assert_eq!(polys.len(), 2, "expected two islands: {polys:?}");
        let (clear, _) = min_clearance_and_width(&polys);
        assert!(
            (clear.unwrap() - 0.2).abs() < 0.02,
            "clearance ≈ 0.2: {clear:?}"
        );
    }

    /// A BAY (deep narrow notch) is a void between two outward-facing faces of
    /// the SAME piece — NOT a copper neck. The slot is 0.1 mm wide but it's empty,
    /// so it must NOT be reported as 0.1 mm copper width. (Interiorness filter.)
    #[test]
    fn bay_notch_is_not_reported_as_thin_copper() {
        use crate::geometry::fill_polygons;
        // 2×2 block with a 0.1 mm-wide slot cut from the top down to y=0.5.
        let notched = vec![
            [0.0, 0.0],
            [2.0, 0.0],
            [2.0, 2.0],
            [1.05, 2.0],
            [1.05, 0.5],
            [0.95, 0.5],
            [0.95, 2.0],
            [0.0, 2.0],
        ];
        let polys = fill_polygons(&[notched], &[]);
        let (_c, w) = clearance_width_hotspots(&polys);
        // No hotspot should sit in the empty slot (mid x≈1.0, y in 0.5..2.0).
        let in_slot = w.iter().any(|h| {
            let mx = (h.0[0] + h.1[0]) / 2.0;
            let my = (h.0[1] + h.1[1]) / 2.0;
            (0.9..=1.1).contains(&mx) && (0.5..=2.0).contains(&my) && h.2 < 0.15
        });
        assert!(
            !in_slot,
            "slot void must not be reported as thin copper: {w:?}"
        );
    }

    /// A WEDGE at an acute convex corner is solid copper but not a neck: its two
    /// bounding faces meet at an acute angle (not anti-parallel). It must NOT be
    /// flagged. (Anti-parallel-faces filter.)
    #[test]
    fn acute_wedge_corner_is_not_reported_as_thin_copper() {
        use crate::geometry::fill_polygons;
        // A thin 30° triangular spike off a body — faces near the tip are at an
        // acute angle, so the tiny cross-distance there is a wedge, not a neck.
        let spike = vec![[0.0, 0.0], [5.0, 0.2], [5.0, -0.2]];
        let polys = fill_polygons(&[spike], &[]);
        let (_c, w) = clearance_width_hotspots(&polys);
        // Near the sharp tip (x≈4.8..5.0) the faces are acute → no neck there.
        let at_tip = w.iter().any(|h| {
            let mx = (h.0[0] + h.1[0]) / 2.0;
            (4.6..=5.0).contains(&mx) && h.2 < 0.15
        });
        assert!(
            !at_tip,
            "acute wedge tip must not be reported as thin copper: {w:?}"
        );
    }

    /// A trace that BENDS is solid copper, not a thin neck: the union of the two
    /// segments + their round line caps makes a concave seam on the inner side of
    /// the turn, and a naive cross-distance there reads as "thin copper" even
    /// though the copper is a full-width trace. (Persistence filter — the narrow
    /// reading does not extend along any corridor.)
    ///
    /// The features are lifted verbatim from a real board (water-meter-cam
    /// led_board, net D1-K): a roundrect pad with a 0.2 mm conductor running +x
    /// then turning 45° down. The pad↔trace union seam at the bend produced a
    /// false 0.11 mm "thin copper" reading. (The pad is required to reproduce it —
    /// the union places a vertex on the trace's bottom edge at the seam.)
    #[test]
    fn trace_bend_is_not_reported_as_thin_copper() {
        use crate::geometry::copper_polygons;
        const BEND: &[u8] = b"%FSLAX46Y46*%\n%MOMM*%\n\
            %AMRoundRect*\n4,1,4,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,0*\n\
            1,1,$1+$1,$2,$3*\n1,1,$1+$1,$4,$5*\n1,1,$1+$1,$6,$7*\n1,1,$1+$1,$8,$9*\n\
            20,1,$1+$1,$2,$3,$4,$5,0*\n20,1,$1+$1,$4,$5,$6,$7,0*\n\
            20,1,$1+$1,$6,$7,$8,$9,0*\n20,1,$1+$1,$8,$9,$2,$3,0*\n%\n\
            %ADD10RoundRect,0.165000X-0.885000X0.385000X-0.885000X-0.385000X0.885000X-0.385000X0.885000X0.385000X0*%\n\
            %ADD15C,0.200000*%\n\
            D10*\nX57800000Y-50700000D03*\n\
            D15*\n\
            X57800000Y-50700000D02*\nX59000000Y-50700000D01*\n\
            X59000000Y-50700000D02*\nX60400000Y-52100000D01*\nM02*\n";
        let polys = copper_polygons(BEND, &[]).unwrap();
        assert_eq!(polys.len(), 1, "the bent trace is one island: {polys:?}");
        let (_c, width) = clearance_width_hotspots(&polys);
        // The bend sits at the junction (x≈59.0, y≈-50.8). No sub-limit copper-
        // width hotspot may land there — the copper is a solid 0.2 mm trace.
        let at_bend = width.iter().any(|h| {
            let mx = (h.0[0] + h.1[0]) / 2.0;
            let my = (h.0[1] + h.1[1]) / 2.0;
            (58.6..=59.4).contains(&mx) && (-51.1..=-50.5).contains(&my) && h.2 < 0.15
        });
        assert!(
            !at_bend,
            "trace bend must not be reported as thin copper: {width:?}"
        );
    }

    #[test]
    fn region_polygons_excludes_trace_strokes() {
        // A pad flash (D03) plus a thin trace draw (D01). region_polygons must keep
        // the pad and drop the trace → no thin neck to find on the region set.
        let regions = region_polygons(PAD_AND_TRACE, &[]).unwrap();
        let full = layer_polygons(PAD_AND_TRACE, &[]).unwrap();
        let (_c, full_w) = clearance_width_hotspots(&full);
        assert!(
            full_w.iter().any(|h| h.2 < 0.15),
            "trace neck should show in full union: {full_w:?}"
        );
        let (_c, region_w) = clearance_width_hotspots(&regions);
        assert!(
            !region_w.iter().any(|h| h.2 < 0.15),
            "region set must have no thin neck: {region_w:?}"
        );
    }

    #[test]
    fn min_copper_width_of_a_thin_trace() {
        use crate::geometry::fill_polygons;
        // A 0.1 mm wide, 5 mm long bar: the two long edges are 0.1 mm apart.
        let bar = vec![[0.0, 0.0], [5.0, 0.0], [5.0, 0.1], [0.0, 0.1]];
        let polys = fill_polygons(&[bar], &[]);
        assert_eq!(polys.len(), 1);
        let (clear, width) = min_clearance_and_width(&polys);
        assert!(clear.is_none(), "single island → no clearance: {clear:?}");
        assert!(
            (width.unwrap() - 0.1).abs() < 0.02,
            "width ≈ 0.1: {width:?}"
        );
    }

    // Bit-identical guard for the Want-split: computing only one side must yield
    // EXACTLY the side that the combined `Both` path produces. In-process float
    // equality → platform-independent. Uses real multi-primitive fixtures so the
    // clearance AND width sets are both non-trivial.
    #[test]
    fn split_matches_both() {
        const A: &[u8] = include_bytes!("../../../../testdata/gerber/two_square_boxes.gbr");
        const B: &[u8] = include_bytes!("../../../../testdata/gerber/polarities_and_apertures.gbr");
        for bytes in [A, B] {
            let polys = layer_polygons(bytes, &[]).unwrap();
            let (both_c, both_w) = hotspots(&polys, Want::Both);
            let (clear_only, empty_w) = hotspots(&polys, Want::Clearance);
            let (empty_c, width_only) = hotspots(&polys, Want::Width);
            assert_eq!(clear_only, both_c, "Clearance-only must equal Both.0");
            assert!(empty_w.is_empty(), "Clearance mode yields no width");
            assert_eq!(width_only, both_w, "Width-only must equal Both.1");
            assert!(empty_c.is_empty(), "Width mode yields no clearance");
            // The public wrappers must match the core.
            assert_eq!(
                clearance_hotspots(&polys),
                both_c,
                "clearance_hotspots == Both.0"
            );
            assert_eq!(width_hotspots(&polys), both_w, "width_hotspots == Both.1");
        }
    }

    // Parallel sweep with ordered-merge must equal a single serial pass, bit-for-bit,
    // for ANY chunk count. Uses fixtures dense enough that several chunks each collect
    // real candidates, so the merge order is actually exercised. In-process → arch-safe.
    #[test]
    fn chunked_sweep_matches_serial() {
        const A: &[u8] = include_bytes!("../../../../testdata/gerber/two_square_boxes.gbr");
        const B: &[u8] = include_bytes!("../../../../testdata/gerber/polarities_and_apertures.gbr");
        for bytes in [A, B] {
            let polys = layer_polygons(bytes, &[]).unwrap();
            for want in [Want::Clearance, Want::Width, Want::Both] {
                let serial = hotspots_chunked(&polys, want, Some(1));
                for nchunks in [2usize, 3, 7, 16, 32, 64] {
                    let parallel = hotspots_chunked(&polys, want, Some(nchunks));
                    assert_eq!(
                        serial, parallel,
                        "chunks={nchunks} must match serial for {want:?}"
                    );
                }
                // The production auto path (None) must also match serial.
                let auto = hotspots_chunked(&polys, want, None);
                assert_eq!(serial, auto, "auto chunking must match serial for {want:?}");
            }
        }
    }

    // A single-thread rayon pool forces ALL chunks onto one worker, which reuses
    // its `visited` buffer across them — the case `map_init` introduces. The
    // monotonic generation counter (never reset between chunks) must keep this
    // bit-identical to a serial pass.
    #[test]
    fn visited_reuse_single_worker_matches_serial() {
        const A: &[u8] = include_bytes!("../../../../testdata/gerber/two_square_boxes.gbr");
        const B: &[u8] = include_bytes!("../../../../testdata/gerber/polarities_and_apertures.gbr");
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(1)
            .build()
            .unwrap();
        for bytes in [A, B] {
            let polys = layer_polygons(bytes, &[]).unwrap();
            for want in [Want::Clearance, Want::Width, Want::Both] {
                let serial = hotspots_chunked(&polys, want, Some(1));
                let reused = pool.install(|| hotspots_chunked(&polys, want, Some(7)));
                assert_eq!(
                    serial, reused,
                    "single-worker visited reuse must match serial for {want:?}"
                );
            }
        }
    }

    #[test]
    fn clearance_hotspot_lands_in_the_gap() {
        use crate::geometry::fill_polygons;
        let a = vec![[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]];
        let b = vec![[1.2, 0.0], [2.2, 0.0], [2.2, 1.0], [1.2, 1.0]];
        let polys = fill_polygons(&[a, b], &[]);
        let (clear, _) = clearance_width_hotspots(&polys);
        assert!(!clear.is_empty(), "expected a clearance hotspot");
        let h = clear[0];
        assert!((h.2 - 0.2).abs() < 0.02, "gap value ≈ 0.2: {}", h.2);
        let midx = (h.0[0] + h.1[0]) / 2.0;
        assert!(
            (1.0..=1.2).contains(&midx),
            "hotspot midpoint sits in the gap: {midx}"
        );
    }
}
