/** Axis-aligned rectangle: top-left origin + size. */
export interface Rect { x: number; y: number; w: number; h: number }

/** 2-D point. */
export interface Pt { x: number; y: number }

// ---------------------------------------------------------------------------
// expand
// ---------------------------------------------------------------------------

/** Returns a new Rect expanded on all four sides by `m`. */
export function expand(r: Rect, m: number): Rect {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

// ---------------------------------------------------------------------------
// holeInZones
// ---------------------------------------------------------------------------

/**
 * True when the point (cx, cy) lies within the region formed by expanding
 * each zone by (holeRadiusMm + clearanceMm) on every side (inclusive check).
 */
export function holeInZones(
  cx: number,
  cy: number,
  holeRadiusMm: number,
  zones: Rect[],
  clearanceMm: number,
): boolean {
  const margin = holeRadiusMm + clearanceMm;
  for (const z of zones) {
    const e = expand(z, margin);
    if (cx >= e.x && cx <= e.x + e.w && cy >= e.y && cy <= e.y + e.h) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// segIntersectsRect  (Liang-Barsky clip, interior-only)
// ---------------------------------------------------------------------------

/**
 * True when segment a→b crosses the INTERIOR of rect r.
 *
 * Boundary-only contact (grazing along an edge or touching a corner) returns
 * false — callers ride expanded-rect edges and must not be penalised for it.
 *
 * Algorithm: Liang-Barsky parametric clip.  The clip produces an interval
 * [t0, t1] ∈ [0,1] describing the part of the segment inside the closed rect.
 * We then check whether the midpoint of that clipped sub-segment lies strictly
 * inside the open rect (all four strict inequalities).  A pure-boundary touch
 * has its midpoint on the boundary, so it returns false; a genuine interior
 * crossing has its midpoint inside, so it returns true.
 *
 * Endpoints inside the (open) rect are caught by the same midpoint test since
 * the clipped interval [t0, t1] will include the interior portion.
 */
export function segIntersectsRect(a: Pt, b: Pt, r: Rect): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  // Liang-Barsky: p * t <= q for each of the 4 slab constraints.
  // Constraints: x in [r.x, r.x+r.w], y in [r.y, r.y+r.h]
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];

  let t0 = 0.0;
  let t1 = 1.0;

  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      // Segment parallel to this slab boundary
      if (q[i] < 0) return false; // entirely outside
      // q[i] >= 0: segment is within this slab (or on boundary), continue
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) {
        // Entering constraint: t0 can only increase
        if (t > t0) t0 = t;
      } else {
        // Leaving constraint: t1 can only decrease
        if (t < t1) t1 = t;
      }
    }
    if (t0 > t1) return false;
  }

  // No intersection interval at all
  if (t0 > t1) return false;

  // Check midpoint of clipped segment is strictly inside the open rect
  const tm = (t0 + t1) / 2;
  const mx = a.x + tm * dx;
  const my = a.y + tm * dy;

  return (
    mx > r.x && mx < r.x + r.w &&
    my > r.y && my < r.y + r.h
  );
}

// ---------------------------------------------------------------------------
// avoidZones
// ---------------------------------------------------------------------------

function dist(a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function polylineLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) len += dist(pts[i], pts[i + 1]);
  return len;
}

/**
 * Returns the intermediate waypoints (excluding a and b) that route the
 * segment a→b around all zones (each expanded by marginMm).
 *
 * Returns [] if the straight line is already clear.
 */
export function avoidZones(
  a: Pt,
  b: Pt,
  zones: Rect[],
  marginMm: number,
): Pt[] {
  const expanded = zones.map((z) => expand(z, marginMm));

  /**
   * Find the first expanded rect (by entry parameter t0) whose interior the
   * segment a→b crosses.
   */
  function firstBlocker(pa: Pt, pb: Pt): Rect | null {
    let best: Rect | null = null;
    let bestT0 = Infinity;

    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;

    for (const r of expanded) {
      if (!segIntersectsRect(pa, pb, r)) continue;

      // Recompute t0 via Liang-Barsky to find entry distance
      const p = [-dx, dx, -dy, dy];
      const q = [
        pa.x - r.x, r.x + r.w - pa.x,
        pa.y - r.y, r.y + r.h - pa.y,
      ];
      let t0 = 0.0;
      let t1 = 1.0;
      let skip = false;
      for (let i = 0; i < 4; i++) {
        if (p[i] === 0) {
          if (q[i] < 0) { skip = true; break; }
        } else {
          const t = q[i] / p[i];
          if (p[i] < 0) { if (t > t0) t0 = t; }
          else { if (t < t1) t1 = t; }
        }
        if (t0 > t1) { skip = true; break; }
      }
      if (skip) continue;

      if (t0 < bestT0) {
        bestT0 = t0;
        best = r;
      }
    }
    return best;
  }

  /**
   * Build candidate detour waypoints around a single rect r.
   * Candidates: each single corner, and each pair of adjacent corners (8 ordered pairs).
   * Keep only candidates where none of the sub-segments [a→...→b] crosses r.
   * Return the shortest kept candidate, or [] if none found.
   */
  function aroundRect(pa: Pt, pb: Pt, r: Rect): Pt[] {
    const corners: Pt[] = [
      { x: r.x,       y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x,       y: r.y + r.h },
    ];

    const candidates: Pt[][] = [];

    // Single-corner candidates
    for (const c of corners) {
      candidates.push([c]);
    }

    // Adjacent-corner pair candidates (4 sides × 2 directions = 8)
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      candidates.push([corners[i], corners[j]]);
      candidates.push([corners[j], corners[i]]);
    }

    let bestWp: Pt[] | null = null;
    let bestLen = Infinity;

    for (const cand of candidates) {
      const pts = [pa, ...cand, pb];
      let blocked = false;
      for (let i = 0; i < pts.length - 1; i++) {
        if (segIntersectsRect(pts[i], pts[i + 1], r)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      const len = polylineLength(pts);
      if (len < bestLen) {
        bestLen = len;
        bestWp = cand;
      }
    }

    return bestWp ?? [];
  }

  function route(pa: Pt, pb: Pt, depth: number): Pt[] {
    if (depth > 8) return [];

    const blocker = firstBlocker(pa, pb);
    if (blocker === null) return [];

    const wp = aroundRect(pa, pb, blocker);
    if (wp.length === 0) return [];

    // Now recursively clear OTHER zones on each leg of the new polyline
    const allPts = [pa, ...wp, pb];
    const out: Pt[] = [];
    for (let i = 0; i < allPts.length - 1; i++) {
      const sub = route(allPts[i], allPts[i + 1], depth + 1);
      out.push(...sub);
      if (i < allPts.length - 2) {
        out.push(allPts[i + 1]);
      }
    }
    return out;
  }

  return route(a, b, 0);
}
