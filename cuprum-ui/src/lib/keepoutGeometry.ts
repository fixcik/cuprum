/** Axis-aligned rectangle: top-left origin + size. */
export interface Rect { x: number; y: number; w: number; h: number }

/** 2-D point. */
export interface Pt { x: number; y: number }

/** Clearance (mm) used when routing the drill traverse around keep-out zones.
 *  The path rides the expanded-rect boundary at this offset from the zone edge. */
export const KEEPOUT_TRAVERSE_MARGIN_MM = 1.0;

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
