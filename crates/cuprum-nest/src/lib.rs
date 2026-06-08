//! Dense rectangle packing for panelization.
//!
//! Places as many identical boards (with optional 0°/90° rotation) as possible on
//! a panel, weaving around obstacles (keep-out zones, tooling holes, clamp fields).
//! A greedy bottom-left fill seeds an incumbent, then a corner-point
//! branch-and-bound improves on it within a time budget. All lengths are mm.
//!
//! This lives in Rust (not the UI) because the search is the heavy part of
//! panelization; the frontend keeps only a light greedy packer for live preview.

use std::time::{Duration, Instant};

const EPS: f64 = 1e-6;

/// Axis-aligned rectangle (mm).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Rect {
    fn overlaps(&self, o: &Rect) -> bool {
        self.min_x < o.max_x - EPS
            && self.max_x > o.min_x + EPS
            && self.min_y < o.max_y - EPS
            && self.max_y > o.min_y + EPS
    }
    fn inflate(&self, by: f64) -> Rect {
        Rect {
            min_x: self.min_x - by,
            min_y: self.min_y - by,
            max_x: self.max_x + by,
            max_y: self.max_y + by,
        }
    }
}

/// A placed board: top-left of its (possibly rotated) footprint, plus the 90° flag.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Placement {
    pub x: f64,
    pub y: f64,
    pub rotated: bool,
}

/// Packing request. `clearance_mm` inflates obstacles; `gap_mm` separates boards.
#[derive(Clone, Debug)]
pub struct PackInput {
    pub board_w: f64,
    pub board_h: f64,
    pub panel_w: f64,
    pub panel_h: f64,
    pub requested: usize,
    pub margin_mm: f64,
    pub gap_mm: f64,
    pub clearance_mm: f64,
    pub mix_rotation: bool,
    pub force_rotate: bool,
    pub obstacles: Vec<Rect>,
    pub time_budget_ms: u64,
}

/// Orientation footprint: (width, height, rotated?).
type Orient = (f64, f64, bool);

struct Ctx {
    inner: Rect,
    orients: Vec<Orient>,
    /// Obstacles inflated by clearance (board-to-obstacle spacing baked in).
    obstacles: Vec<Rect>,
    gap: f64,
    board_area: f64,
    requested: usize,
    deadline: Instant,
}

fn orientations(input: &PackInput) -> Vec<Orient> {
    let (w, h) = (input.board_w, input.board_h);
    if input.mix_rotation {
        vec![(w, h, false), (h, w, true)]
    } else if input.force_rotate {
        vec![(h, w, true)]
    } else {
        vec![(w, h, false)]
    }
}

/// Candidate left/top coordinates for a footprint of size `size` along one axis:
/// the inner-low wall, the flush-high wall, and each blocker's far/near edge.
fn axis_candidates(lo: f64, hi: f64, size: f64, blockers_edges: &[(f64, f64)]) -> Vec<f64> {
    let mut out = vec![lo, hi - size];
    for &(near, far) in blockers_edges {
        out.push(far); // place just past a blocker's far edge
        out.push(near - size); // place flush against a blocker's near edge
    }
    out.retain(|&v| v >= lo - EPS && v <= hi - size + EPS);
    out.sort_by(|a, b| a.partial_cmp(b).unwrap());
    out.dedup_by(|a, b| (*a - *b).abs() < EPS);
    out
}

/// True if `r` fits inside the inner band and clears every blocker.
fn fits(ctx: &Ctx, r: &Rect, placed_spaced: &[Rect]) -> bool {
    if r.min_x < ctx.inner.min_x - EPS
        || r.min_y < ctx.inner.min_y - EPS
        || r.max_x > ctx.inner.max_x + EPS
        || r.max_y > ctx.inner.max_y + EPS
    {
        return false;
    }
    if ctx.obstacles.iter().any(|o| r.overlaps(o)) {
        return false;
    }
    if placed_spaced.iter().any(|p| r.overlaps(p)) {
        return false;
    }
    true
}

/// (near, far) edge pairs along one axis, for corner-point candidate generation.
type EdgePairs = Vec<(f64, f64)>;

/// Blocker edges along x and y (obstacles + already-placed-inflated-by-gap), for
/// corner-point candidate generation.
fn blocker_edges(ctx: &Ctx, placed_spaced: &[Rect]) -> (EdgePairs, EdgePairs) {
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    for b in ctx.obstacles.iter().chain(placed_spaced.iter()) {
        xs.push((b.min_x, b.max_x));
        ys.push((b.min_y, b.max_y));
    }
    (xs, ys)
}

/// First open point (min y, then x) over all orientations, skipping dead points.
fn first_open(ctx: &Ctx, placed_spaced: &[Rect], dead: &[(f64, f64)]) -> Option<(f64, f64)> {
    let (xe, ye) = blocker_edges(ctx, placed_spaced);
    let mut best: Option<(f64, f64)> = None;
    for &(bw, bh, _) in &ctx.orients {
        let xs = axis_candidates(ctx.inner.min_x, ctx.inner.max_x, bw, &xe);
        let ys = axis_candidates(ctx.inner.min_y, ctx.inner.max_y, bh, &ye);
        for &y in &ys {
            // Early out: once we have a best with a smaller y, deeper ys can't win.
            if let Some((_, by)) = best {
                if y > by + EPS {
                    break;
                }
            }
            for &x in &xs {
                if dead
                    .iter()
                    .any(|&(dx, dy)| (dx - x).abs() < EPS && (dy - y).abs() < EPS)
                {
                    continue;
                }
                let r = Rect {
                    min_x: x,
                    min_y: y,
                    max_x: x + bw,
                    max_y: y + bh,
                };
                if !fits(ctx, &r, placed_spaced) {
                    continue;
                }
                let better = match best {
                    None => true,
                    Some((bx, by)) => y < by - EPS || ((y - by).abs() < EPS && x < bx - EPS),
                };
                if better {
                    best = Some((x, y));
                }
            }
        }
    }
    best
}

struct Search {
    best: Vec<Placement>,
    timed_out: bool,
}

/// Depth-first placement with a bounded number of "skips" (points deliberately
/// left empty). Limiting skips turns the otherwise near-brute-force search into a
/// limited-discrepancy search: dense packings that need only a few awkward gaps
/// around obstacles are found quickly. `skips_left` caps the skip branches.
fn dfs(
    ctx: &Ctx,
    placed: &mut Vec<Placement>,
    placed_spaced: &mut Vec<Rect>,
    dead: &mut Vec<(f64, f64)>,
    skips_left: i32,
    s: &mut Search,
) {
    if placed.len() > s.best.len() {
        s.best = placed.clone();
    }
    if s.best.len() >= ctx.requested {
        return; // reached the cap — nothing better to find
    }
    if Instant::now() >= ctx.deadline {
        s.timed_out = true;
        return;
    }
    // Upper bound: remaining inner area / board area (obstacles ignored → safe).
    let inner_area =
        (ctx.inner.max_x - ctx.inner.min_x).max(0.0) * (ctx.inner.max_y - ctx.inner.min_y).max(0.0);
    let bound = placed.len()
        + ((inner_area - placed.len() as f64 * ctx.board_area) / ctx.board_area)
            .floor()
            .max(0.0) as usize;
    if bound <= s.best.len() {
        return;
    }
    let p = match first_open(ctx, placed_spaced, dead) {
        Some(p) => p,
        None => return, // no more placements in this branch
    };
    let (x, y) = p;
    // Branch 1..k: place a board at p in each fitting orientation (place first).
    for &(bw, bh, rotated) in &ctx.orients {
        let r = Rect {
            min_x: x,
            min_y: y,
            max_x: x + bw,
            max_y: y + bh,
        };
        if !fits(ctx, &r, placed_spaced) {
            continue;
        }
        placed.push(Placement { x, y, rotated });
        placed_spaced.push(r.inflate(ctx.gap));
        dfs(ctx, placed, placed_spaced, dead, skips_left, s);
        placed.pop();
        placed_spaced.pop();
        if s.best.len() >= ctx.requested || s.timed_out {
            return;
        }
    }
    // Branch 0: leave p empty for the rest of this subtree (costs one skip).
    if skips_left > 0 {
        dead.push(p);
        dfs(ctx, placed, placed_spaced, dead, skips_left - 1, s);
        dead.pop();
    }
}

/// Greedy bottom-left fill: always place the first fitting orientation at the first
/// open point. Fast, no backtracking — the branch-and-bound incumbent.
fn greedy(ctx: &Ctx) -> Vec<Placement> {
    let mut placed = Vec::new();
    let mut placed_spaced: Vec<Rect> = Vec::new();
    let dead: Vec<(f64, f64)> = Vec::new();
    while placed.len() < ctx.requested {
        let Some((x, y)) = first_open(ctx, &placed_spaced, &dead) else {
            break;
        };
        let mut put = false;
        for &(bw, bh, rotated) in &ctx.orients {
            let r = Rect {
                min_x: x,
                min_y: y,
                max_x: x + bw,
                max_y: y + bh,
            };
            if fits(ctx, &r, &placed_spaced) {
                placed.push(Placement { x, y, rotated });
                placed_spaced.push(r.inflate(ctx.gap));
                put = true;
                break;
            }
        }
        if !put {
            break;
        }
    }
    placed
}

/// Pack up to `requested` boards. Returns footprint top-lefts + rotation flags.
pub fn pack(input: &PackInput) -> Vec<Placement> {
    if input.requested == 0 {
        return Vec::new();
    }
    let inner = Rect {
        min_x: input.margin_mm,
        min_y: input.margin_mm,
        max_x: input.panel_w - input.margin_mm,
        max_y: input.panel_h - input.margin_mm,
    };
    if inner.max_x - inner.min_x <= EPS || inner.max_y - inner.min_y <= EPS {
        return Vec::new();
    }
    let ctx = Ctx {
        inner,
        orients: orientations(input),
        obstacles: input
            .obstacles
            .iter()
            .map(|o| o.inflate(input.clearance_mm))
            .collect(),
        gap: input.gap_mm,
        board_area: (input.board_w * input.board_h).max(EPS),
        requested: input.requested,
        deadline: Instant::now() + Duration::from_millis(input.time_budget_ms.max(1)),
    };
    let incumbent = greedy(&ctx);
    let mut s = Search {
        best: incumbent,
        timed_out: false,
    };
    // Iterative deepening on the skip budget: solutions needing few empty points are
    // found first and cheaply; widen until we hit the cap or run out of time.
    const MAX_SKIPS: i32 = 16;
    let mut skips = 0;
    while s.best.len() < ctx.requested && !s.timed_out && skips <= MAX_SKIPS {
        let mut placed = Vec::new();
        let mut placed_spaced = Vec::new();
        let mut dead = Vec::new();
        dfs(
            &ctx,
            &mut placed,
            &mut placed_spaced,
            &mut dead,
            skips,
            &mut s,
        );
        skips += 1;
    }
    s.best
}

#[cfg(test)]
mod tests {
    use super::*;

    fn footprint(p: &Placement, w: f64, h: f64) -> Rect {
        let (bw, bh) = if p.rotated { (h, w) } else { (w, h) };
        Rect {
            min_x: p.x,
            min_y: p.y,
            max_x: p.x + bw,
            max_y: p.y + bh,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn assert_valid(
        out: &[Placement],
        w: f64,
        h: f64,
        panel: (f64, f64),
        margin: f64,
        gap: f64,
        obstacles: &[Rect],
        clearance: f64,
    ) {
        let boxes: Vec<Rect> = out.iter().map(|p| footprint(p, w, h)).collect();
        for (i, a) in boxes.iter().enumerate() {
            // inside margin band
            assert!(
                a.min_x >= margin - 1e-3 && a.min_y >= margin - 1e-3,
                "off panel: {a:?}"
            );
            assert!(
                a.max_x <= panel.0 - margin + 1e-3 && a.max_y <= panel.1 - margin + 1e-3,
                "off panel: {a:?}"
            );
            // gap between boards
            for b in boxes.iter().skip(i + 1) {
                assert!(
                    !a.inflate(gap).overlaps(b),
                    "boards closer than gap: {a:?} {b:?}"
                );
            }
            // clear of obstacles
            for o in obstacles {
                assert!(
                    !a.overlaps(&o.inflate(clearance)),
                    "board in obstacle clearance: {a:?} {o:?}"
                );
            }
        }
    }

    #[test]
    fn fits_six_around_side_keepouts_real_case() {
        // The real test3 case: board 27.1×40, panel 100×100, two side keep-out zones
        // and two corner registration holes. Hand-packing fits 6 with a tightest gap
        // of ~1.1 mm; greedy packers only reach 5. The solver must find 6 at gap 1.0.
        let hole = |cx: f64, cy: f64| {
            let r = 1.5; // diameter 3 / 2
            Rect {
                min_x: cx - r,
                min_y: cy - r,
                max_x: cx + r,
                max_y: cy + r,
            }
        };
        let obstacles = vec![
            Rect {
                min_x: 0.0,
                min_y: 35.0,
                max_x: 11.0,
                max_y: 57.0,
            },
            Rect {
                min_x: 91.0,
                min_y: 34.0,
                max_x: 100.0,
                max_y: 62.0,
            },
            hole(5.53, 94.11),
            hole(95.32, 3.72),
        ];
        let input = PackInput {
            board_w: 27.1,
            board_h: 40.0,
            panel_w: 100.0,
            panel_h: 100.0,
            requested: 6,
            margin_mm: 1.0,
            gap_mm: 1.0,
            clearance_mm: 1.0,
            mix_rotation: true,
            force_rotate: false,
            obstacles: obstacles.clone(),
            time_budget_ms: 3000,
        };
        let out = pack(&input);
        assert_eq!(out.len(), 6, "solver should fit 6 like hand-packing");
        assert_valid(&out, 27.1, 40.0, (100.0, 100.0), 1.0, 1.0, &obstacles, 1.0);
    }

    #[test]
    fn solver_is_at_least_as_good_as_greedy() {
        let input = PackInput {
            board_w: 27.1,
            board_h: 40.0,
            panel_w: 100.0,
            panel_h: 100.0,
            requested: 6,
            margin_mm: 1.5,
            gap_mm: 1.5,
            clearance_mm: 1.5,
            mix_rotation: true,
            force_rotate: false,
            obstacles: vec![Rect {
                min_x: 0.0,
                min_y: 35.0,
                max_x: 11.0,
                max_y: 57.0,
            }],
            time_budget_ms: 3000,
        };
        let inner = Rect {
            min_x: 1.5,
            min_y: 1.5,
            max_x: 98.5,
            max_y: 98.5,
        };
        let ctx = Ctx {
            inner,
            orients: orientations(&input),
            obstacles: input.obstacles.iter().map(|o| o.inflate(1.5)).collect(),
            gap: 1.5,
            board_area: 27.1 * 40.0,
            requested: 6,
            deadline: Instant::now() + Duration::from_millis(50),
        };
        let g = greedy(&ctx).len();
        let out = pack(&input).len();
        assert!(out >= g, "solver {out} < greedy {g}");
    }

    #[test]
    fn deterministic_when_completed() {
        let input = PackInput {
            board_w: 27.1,
            board_h: 40.0,
            panel_w: 100.0,
            panel_h: 100.0,
            requested: 6,
            margin_mm: 1.5,
            gap_mm: 1.5,
            clearance_mm: 1.5,
            mix_rotation: true,
            force_rotate: false,
            obstacles: vec![Rect {
                min_x: 0.0,
                min_y: 35.0,
                max_x: 11.0,
                max_y: 57.0,
            }],
            time_budget_ms: 3000,
        };
        assert_eq!(pack(&input), pack(&input));
    }

    #[test]
    fn empty_and_oversize_edge_cases() {
        let base = PackInput {
            board_w: 27.1,
            board_h: 40.0,
            panel_w: 100.0,
            panel_h: 100.0,
            requested: 0,
            margin_mm: 5.0,
            gap_mm: 1.0,
            clearance_mm: 1.0,
            mix_rotation: true,
            force_rotate: false,
            obstacles: vec![],
            time_budget_ms: 100,
        };
        assert!(pack(&base).is_empty()); // requested 0
        let oversize = PackInput {
            requested: 3,
            board_w: 200.0,
            board_h: 200.0,
            ..base.clone()
        };
        assert!(pack(&oversize).is_empty()); // board larger than panel
        let tiny_panel = PackInput {
            requested: 3,
            margin_mm: 60.0,
            ..base.clone()
        };
        assert!(pack(&tiny_panel).is_empty()); // margin eats the whole panel
    }

    #[test]
    fn single_orientation_when_mix_off() {
        let input = PackInput {
            board_w: 40.0,
            board_h: 15.0,
            panel_w: 50.0,
            panel_h: 42.0,
            requested: 3,
            margin_mm: 0.0,
            gap_mm: 0.0,
            clearance_mm: 0.0,
            mix_rotation: false,
            force_rotate: false,
            obstacles: vec![],
            time_budget_ms: 500,
        };
        let out = pack(&input);
        assert!(out.iter().all(|p| !p.rotated));
    }
}
