import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";

// Shared board-outline reconstruction. Edge_Cuts is a set of disjoint line/arc
// STROKES around the perimeter, not a closed filled shape — we chain them into
// closed loops. Used by the 3D substrate (THREE.Shape) and the 2D mask clip
// (SVG path), so both agree on exactly where the board is.

function parse(svgBody: string) {
  // SVGLoader cannot parse the CSS keyword `currentColor`; swap for a concrete colour.
  const doc = `<svg xmlns="http://www.w3.org/2000/svg">${svgBody.replace(/currentColor/g, "#ffffff")}</svg>`;
  return new SVGLoader().parse(doc);
}

function polylines(svgBody: string): THREE.Vector2[][] {
  const all: THREE.Vector2[][] = [];
  const strokesOnly: THREE.Vector2[][] = [];
  for (const p of parse(svgBody).paths) {
    const style = p.userData?.style as { fill?: string; stroke?: string; strokeWidth?: number } | undefined;
    // A stroked path is one of the actual outline lines/arcs (fill="none").
    // Filled shapes with no stroke are the round line-cap CIRCLES the emitter
    // drops at every vertex — as closed loops they'd be mistaken for inner board
    // cutouts and tear the edge triangulation (spikes / green leaks at corners).
    const isStroke = !!style?.strokeWidth && style.stroke !== "none";
    for (const sub of p.subPaths) {
      const pts = sub.getPoints();
      if (pts.length < 2) continue;
      // Drop zero-length (degenerate flash) segments.
      if (pts.length === 2 && pts[0].distanceTo(pts[1]) < 1e-4) continue;
      all.push(pts);
      if (isStroke) strokesOnly.push(pts);
    }
  }
  // Prefer the stroked outline; fall back to everything if a board draws its
  // outline as a filled region instead of strokes.
  return strokesOnly.length > 0 ? strokesOnly : all;
}

/** Drop consecutive points closer than `eps` (welding — fixes shared arc/line
 *  endpoints and the degenerate start flash that confuse earcut). */
function weld(loop: THREE.Vector2[], eps = 1e-3): THREE.Vector2[] {
  const out: THREE.Vector2[] = [];
  for (const p of loop) {
    if (out.length === 0 || out[out.length - 1].distanceTo(p) > eps) out.push(p);
  }
  while (out.length > 1 && out[0].distanceTo(out[out.length - 1]) <= eps) out.pop();
  return out;
}

/** Stitch open polylines into closed loops by matching endpoints within `tol` mm. */
export function stitchLoops(polys: THREE.Vector2[][], tol = 0.05): THREE.Vector2[][] {
  const segs = polys.filter((p) => p.length >= 2);
  const used = new Array(segs.length).fill(false);
  const near = (a: THREE.Vector2, b: THREE.Vector2) => a.distanceTo(b) <= tol;
  const loops: THREE.Vector2[][] = [];

  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const loop = segs[i].slice();

    let extended = true;
    while (extended) {
      extended = false;
      const end = loop[loop.length - 1];
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const s = segs[j];
        if (near(end, s[0])) { loop.push(...s.slice(1)); used[j] = true; extended = true; break; }
        if (near(end, s[s.length - 1])) { loop.push(...s.slice(0, -1).reverse()); used[j] = true; extended = true; break; }
      }
      if (extended) continue;
      const start = loop[0];
      for (let j = 0; j < segs.length; j++) {
        if (used[j]) continue;
        const s = segs[j];
        if (near(start, s[s.length - 1])) { loop.unshift(...s.slice(0, -1)); used[j] = true; extended = true; break; }
        if (near(start, s[0])) { loop.unshift(...s.slice(1).reverse()); used[j] = true; extended = true; break; }
      }
    }
    loops.push(loop);
  }
  return loops;
}

/** Closed loops from an Edge_Cuts SVG fragment, largest (board outline) first. */
export function outlineLoops(svgBody: string): THREE.Vector2[][] {
  const loops = stitchLoops(polylines(svgBody))
    .map((l) => weld(l))
    .filter((l) => l.length >= 3);
  const area = (pts: THREE.Vector2[]) => Math.abs(THREE.ShapeUtils.area(pts));
  loops.sort((a, b) => area(b) - area(a));
  return loops;
}

/** Board outline as an SVG path `d` (all loops, for use as a clip path). */
export function outlinePathD(svgBody: string): string | null {
  const loops = outlineLoops(svgBody);
  if (loops.length === 0) return null;
  return loops
    .map((l) => "M" + l.map((p) => `${p.x.toFixed(3)} ${p.y.toFixed(3)}`).join(" L ") + " Z")
    .join(" ");
}
