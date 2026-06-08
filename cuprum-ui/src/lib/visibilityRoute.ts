import type { Pt, Rect } from "@/lib/keepoutGeometry";
import { expand, segIntersectsRect } from "@/lib/keepoutGeometry";

const EPS = 1e-9;

/** Closed-rect point test: true when p is inside or on the boundary of r. */
export function pointInRect(p: Pt, r: Rect): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Strict-interior point test (used to drop a clipped node that lands inside a
 *  zone — boundary contact is allowed, the routing rides expanded-zone edges). */
function insideStrict(p: Pt, r: Rect): boolean {
  return p.x > r.x + EPS && p.x < r.x + r.w - EPS && p.y > r.y + EPS && p.y < r.y + r.h - EPS;
}

/** Panel bounds in the routing coordinate space: the axis-aligned rectangle
 *  [minX,maxX]×[minY,maxY]. An empty/degenerate rect (maxX<=minX or maxY<=minY)
 *  means "unbounded" (no boundary constraint). Given as explicit min/max rather
 *  than width/height so callers in machine space — where the panel can map to a
 *  negative-origin quadrant depending on the datum corner — can pass the real
 *  rectangle. */
export interface PanelBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

function clampToPanel(p: Pt, panel: PanelBounds): Pt {
  return {
    x: Math.min(panel.maxX, Math.max(panel.minX, p.x)),
    y: Math.min(panel.maxY, Math.max(panel.minY, p.y)),
  };
}

/**
 * Intermediate waypoints (excluding a and b) that route the segment a→b around
 * all `obstacles` (each expanded by `marginMm`) via a visibility graph + Dijkstra
 * shortest path. Same return contract as the legacy `avoidZones`: [] when the
 * straight line is already clear.
 *
 * When `panel` is given (width,height > 0) every waypoint is constrained to the
 * panel rectangle [0,width]×[0,height]: obstacle corners outside the panel are
 * clipped to it (dropped if the clip lands strictly inside an obstacle). Because
 * the panel is convex, an edge between two in-panel nodes is fully in-panel, so
 * no per-edge boundary clip is needed — Dijkstra naturally chooses the in-panel
 * way around instead of a detour that leaves the panel.
 *
 * If no in-panel path exists (an expanded obstacle splits the panel between a and
 * b), logs a warning and returns [] (straight-line fallback).
 */
export function routeAvoiding(
  a: Pt,
  b: Pt,
  obstacles: Rect[],
  marginMm: number,
  panel?: PanelBounds,
): Pt[] {
  const bounded = !!panel && panel.maxX > panel.minX && panel.maxY > panel.minY;
  const expanded = obstacles.map((z) => expand(z, marginMm));

  // Zones that contain an endpoint (a hole sitting inside an expanded zone's
  // margin band). Edges incident to that endpoint are exempt from those zones so
  // the hole can route out — but this exemption applies ONLY to the real
  // endpoints a/b, never to obstacle-corner nodes (a corner lies on a zone
  // boundary, so a blanket exemption would let the path graze through the zone).
  // Assumes keep-out zones are non-overlapping fixture bodies: a convex zone that
  // contains an endpoint is crossed by an incident segment only in the stretch
  // adjacent to that endpoint, so exempting it whole is safe.
  const exemptA = expanded.filter((r) => pointInRect(a, r));
  const exemptB = expanded.filter((r) => pointInRect(b, r));

  // An obstacle blocks segment p→q when the segment crosses its interior and the
  // obstacle is not in this edge's exempt set.
  const segBlocked = (p: Pt, q: Pt, exempt: Rect[]): boolean =>
    expanded.some((r) => !exempt.includes(r) && segIntersectsRect(p, q, r));

  // Fast path: straight line already clear (also covers a===b and no obstacles).
  if (!segBlocked(a, b, [...exemptA, ...exemptB])) return [];

  // Nodes: start (0), goal (1), then each expanded-obstacle corner (clipped to
  // the panel when bounded; dropped if the clip lands inside an obstacle). Dedupe
  // coincident points so the graph stays small and deterministic.
  const nodes: Pt[] = [a, b];
  const pushNode = (raw: Pt) => {
    const p = bounded ? clampToPanel(raw, panel!) : raw;
    if (bounded && expanded.some((r) => insideStrict(p, r))) return;
    if (nodes.some((n) => Math.abs(n.x - p.x) < EPS && Math.abs(n.y - p.y) < EPS)) return;
    nodes.push(p);
  };
  for (const r of expanded) {
    pushNode({ x: r.x, y: r.y });
    pushNode({ x: r.x + r.w, y: r.y });
    pushNode({ x: r.x + r.w, y: r.y + r.h });
    pushNode({ x: r.x, y: r.y + r.h });
  }

  // Dijkstra a(0) → b(1). Deterministic: lowest-index node wins ties (strict <
  // in selection and a `- EPS` relax guard keep the earliest predecessor).
  const n = nodes.length;
  const dist = new Array<number>(n).fill(Infinity);
  const prev = new Array<number>(n).fill(-1);
  const done = new Array<boolean>(n).fill(false);
  dist[0] = 0;
  for (let iter = 0; iter < n; iter++) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    }
    if (u === -1 || u === 1) break;
    done[u] = true;
    for (let v = 0; v < n; v++) {
      if (done[v] || v === u) continue;
      const exempt = [
        ...(u === 0 || v === 0 ? exemptA : []),
        ...(u === 1 || v === 1 ? exemptB : []),
      ];
      if (segBlocked(nodes[u], nodes[v], exempt)) continue;
      const dx = nodes[u].x - nodes[v].x;
      const dy = nodes[u].y - nodes[v].y;
      const w = Math.sqrt(dx * dx + dy * dy);
      if (dist[u] + w < dist[v] - EPS) {
        dist[v] = dist[u] + w;
        prev[v] = u;
      }
    }
  }

  if (!Number.isFinite(dist[1])) {
    console.warn(
      "[routeAvoiding] no in-panel path around keep-out zones; traverse falls back to a straight line that may cross a zone",
    );
    return [];
  }

  // Reconstruct b→a, drop endpoints, reverse to a→b order.
  const path: Pt[] = [];
  for (let at = prev[1]; at !== -1 && at !== 0; at = prev[at]) path.push(nodes[at]);
  path.reverse();
  return path;
}
