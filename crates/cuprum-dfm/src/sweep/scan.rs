//! Core nearest-edge sweep engine: grid construction, parallel range sweep,
//! dedup/sort, and the public hotspot query.

use rayon::prelude::*;

use super::edges::collect_edges;
use super::neck::neck_persists;
use super::segments::seg_seg_closest;
/// Shared project-wide cap on reported hotspots per metric (worst-first); excess
/// is dropped after the ~1 mm-cell dedup.
use crate::HOT_N;
use cuprum_gerber::geometry::{point_in_ring, poly_containing, Poly};

/// Grid resolution for the nearest-edge sweep: cell ≈ board_diag / this.
const DIST_CELLS: f64 = 220.0;
/// Safety cap on segment-pair comparisons (real boards stay well under it).
const DIST_BUDGET: u64 = 120_000_000;

/// Merge hotspots whose midpoints fall in the same ~1 mm cell (so a long thin
/// gap doesn't become dozens of near-identical entries).
const HOT_DEDUP_MM: f64 = 1.0;
/// Safety cap on collected candidates before dedup.
const HOT_COLLECT_CAP: usize = 200_000;

/// Target edges per sweep chunk in the auto path. Small enough that the heaviest
/// (lowest-ei) chunk is a thin slice: each edge scans only `ej > ei`, so low-ei
/// edges carry far more work — fine chunks let rayon work-stealing flatten that
/// triangular load. Bigger = fewer tasks; smaller = finer balance.
const TARGET_CHUNK_EDGES: usize = 512;
/// Upper bound on the auto chunk count, capping task/merge overhead on huge boards.
const MAX_SWEEP_CHUNKS: usize = 256;

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

/// A geometric DFM hotspot: the two closest mm points and the measured distance
/// between them (the value to annotate, e.g. the gap or copper width).
pub type Hot = ([f64; 2], [f64; 2], f64);

/// Which side(s) of the clearance/width sweep to compute. Each caller uses only
/// one: the full-union path needs Clearance, the region path needs Width. Skipping
/// the other side avoids its per-pair work — crucially the O(ring) `point_in_ring`
/// interiorness test of the width branch, which on a dense full-union pour
/// dominated the sweep (~1.5 s of a ~1.9 s call) and was then discarded.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(super) enum Want {
    Clearance,
    Width,
    Both,
}

/// E3: bucket entry with the edge geometry stored INLINE (not an index into a
/// separate `edges[]`), so scanning a grid cell streams contiguous memory and the
/// random `edges[ej]` gather in the hot loop disappears. Duplicated across the
/// cells an edge spans. `ei` keeps the global index for the `ej>ei` ordering and
/// the `visited` dedup.
#[derive(Clone, Copy)]
struct Cand {
    a: [f64; 2],
    b: [f64; 2],
    poly: u32,
    ring: u32,
    idx: u32,
    ei: u32,
}

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

pub(super) fn hotspots(polys: &[Poly], want: Want) -> (Vec<Hot>, Vec<Hot>) {
    hotspots_chunked(polys, want, None)
}

#[tracing::instrument(skip_all, fields(polys = polys.len()))]
pub(super) fn hotspots_chunked(
    polys: &[Poly],
    want: Want,
    nchunks: Option<usize>,
) -> (Vec<Hot>, Vec<Hot>) {
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
    let mut grid: Vec<Vec<Cand>> = vec![Vec::new(); (nx * ny) as usize];
    {
        let _gb = tracing::info_span!("grid_build", edges = edges.len()).entered();
        for (ei, e) in edges.iter().enumerate() {
            let cand = Cand {
                a: e.a,
                b: e.b,
                poly: e.poly,
                ring: e.ring,
                idx: e.idx,
                ei: ei as u32,
            };
            let (cx0, cy0) = key(e.a[0].min(e.b[0]), e.a[1].min(e.b[1]));
            let (cx1, cy1) = key(e.a[0].max(e.b[0]), e.a[1].max(e.b[1]));
            // Clamp the high index (a coordinate exactly at max maps to nx/ny).
            let cx1 = cx1.min(nx - 1);
            let cy1 = cy1.min(ny - 1);
            for gx in cx0..=cx1 {
                for gy in cy0..=cy1 {
                    grid[cell_at(gx, gy)].push(cand);
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
                    for &f in bucket {
                        let ej = f.ei as usize;
                        if ej <= ei || visited[ej] == gen {
                            continue;
                        }
                        visited[ej] = gen;
                        let cross = e.poly != f.poly;
                        // inline of `adjacent(e, f)`: same ring, consecutive idx (cyclic)
                        let adj = e.poly == f.poly && e.ring == f.ring && {
                            let d = e.idx.abs_diff(f.idx);
                            d <= 1 || d == e.n - 1
                        };
                        let want_this = match want {
                            Want::Clearance => cross,
                            Want::Width => !cross && !adj,
                            Want::Both => cross || !adj,
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
        let dh = cuprum_trace::capture_dispatch();
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

#[cfg(test)]
mod tests {
    use super::*;
    use cuprum_gerber::geometry::layer_polygons;

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
                crate::clearance_hotspots(&polys),
                both_c,
                "clearance_hotspots == Both.0"
            );
            assert_eq!(
                crate::width_hotspots(&polys),
                both_w,
                "width_hotspots == Both.1"
            );
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
}
