// Shared board-outline reconstruction. Edge_Cuts is a set of disjoint line/arc
// STROKES around the perimeter, not a closed filled shape — we chain them into
// closed loops. Used by the 2D mask clip (SVG path `d`) and the board extent.
//
// Pure 2D geometry, no three.js: the renderer (cuprum-gerber/src/svg.rs) only ever
// emits absolute `M`/`L`/`Z` path commands (arcs are pre-tessellated into
// polylines), so a tiny path tokenizer + plain {x,y} math replaces three's
// SVGLoader / Vector2 / ShapeUtils and keeps three out of the startup bundle.

/** A 2D point. */
export interface Vec2 {
  x: number;
  y: number;
}

const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Signed area of a closed polygon (shoelace). Magnitude matches the value the
 *  outline code previously took via `Math.abs(THREE.ShapeUtils.area(pts))`. */
function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let p = pts.length - 1, q = 0; q < pts.length; p = q++) {
    a += pts[p].x * pts[q].y - pts[q].x * pts[p].y;
  }
  return a * 0.5;
}

/** Walk up from an element to find the effective value of a presentation
 *  attribute (SVG inherits `stroke` from ancestor `<g>` groups). */
function inheritedAttr(el: Element | null, name: string): string | null {
  for (let n: Element | null = el; n; n = n.parentElement) {
    const v = n.getAttribute(name);
    if (v !== null) return v;
  }
  return null;
}

/** Split an absolute `M`/`L`/`Z` path `d` into one point list per subpath (each
 *  `M` starts a new subpath). The renderer never emits relative or curve commands,
 *  so only `M`/`L` contribute points and `Z` (close) adds none — the closing
 *  duplicate is handled later by `weld`. */
function subpathsFromPathD(d: string): Vec2[][] {
  const toks = d.match(/[A-Za-z]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
  const subs: Vec2[][] = [];
  let cur: Vec2[] | null = null;
  let i = 0;
  while (i < toks.length) {
    const t = toks[i++];
    if (t === "M" || t === "L") {
      const x = Number(toks[i++]);
      const y = Number(toks[i++]);
      if (t === "M" || !cur) {
        cur = [];
        subs.push(cur);
      }
      cur.push({ x, y });
    }
    // `Z` and any unexpected command contribute no points.
  }
  return subs;
}

/** Every drawn polyline in an SVG fragment, tagged with whether it is a stroke
 *  (the actual outline lines) rather than a filled shape. Mirrors what the old
 *  SVGLoader path produced: `<path>` (and `<polyline>`/`<polygon>`) subpaths,
 *  classified by their effective stroke. Filled flashes (`<circle>`/`<rect>`,
 *  always `stroke="none"`) are never outlines, so they are skipped. */
function drawnPolylines(svgBody: string): { pts: Vec2[]; isStroke: boolean }[] {
  const doc = new DOMParser().parseFromString(
    `<svg xmlns="http://www.w3.org/2000/svg">${svgBody}</svg>`,
    "image/svg+xml",
  );
  const out: { pts: Vec2[]; isStroke: boolean }[] = [];

  const classify = (el: Element): boolean => {
    // A stroked path is one of the actual outline lines/arcs (own stroke-width set,
    // effective stroke not "none"). Filled shapes (stroke="none") are line-cap caps
    // / pours that would be mistaken for cutouts.
    const sw = el.getAttribute("stroke-width");
    const hasWidth = sw !== null && Number(sw) > 0;
    const stroke = inheritedAttr(el, "stroke");
    return hasWidth && stroke !== null && stroke !== "none";
  };

  for (const el of Array.from(doc.querySelectorAll("path"))) {
    const d = el.getAttribute("d");
    if (!d) continue;
    const isStroke = classify(el);
    for (const pts of subpathsFromPathD(d)) {
      if (pts.length >= 2) out.push({ pts, isStroke });
    }
  }
  for (const el of Array.from(doc.querySelectorAll("polyline, polygon"))) {
    const raw = el.getAttribute("points");
    if (!raw) continue;
    const nums = raw.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) ?? [];
    const pts: Vec2[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      pts.push({ x: Number(nums[i]), y: Number(nums[i + 1]) });
    }
    if (pts.length >= 2) out.push({ pts, isStroke: classify(el) });
  }
  return out;
}

/** Stroked outline polylines, or every polyline if a board draws its outline as a
 *  filled region instead of strokes. Drops zero-length (degenerate flash) 2-point
 *  segments. */
function polylines(svgBody: string): Vec2[][] {
  const all: Vec2[][] = [];
  const strokesOnly: Vec2[][] = [];
  for (const { pts, isStroke } of drawnPolylines(svgBody)) {
    if (pts.length === 2 && dist(pts[0], pts[1]) < 1e-4) continue;
    all.push(pts);
    if (isStroke) strokesOnly.push(pts);
  }
  return strokesOnly.length > 0 ? strokesOnly : all;
}

/** Drop consecutive points closer than `eps` (welding — fixes shared arc/line
 *  endpoints and the degenerate start flash that confuse stitching). */
function weld(loop: Vec2[], eps = 1e-3): Vec2[] {
  const out: Vec2[] = [];
  for (const p of loop) {
    if (out.length === 0 || dist(out[out.length - 1], p) > eps) out.push(p);
  }
  while (out.length > 1 && dist(out[0], out[out.length - 1]) <= eps) out.pop();
  return out;
}

/** Stitch open polylines into closed loops by matching endpoints within `tol` mm. */
export function stitchLoops(polys: Vec2[][], tol = 0.05): Vec2[][] {
  const segs = polys.filter((p) => p.length >= 2);
  const used = new Array(segs.length).fill(false);
  const near = (a: Vec2, b: Vec2) => dist(a, b) <= tol;
  const loops: Vec2[][] = [];

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
export function outlineLoops(svgBody: string): Vec2[][] {
  const loops = stitchLoops(polylines(svgBody))
    .map((l) => weld(l))
    .filter((l) => l.length >= 3);
  const area = (pts: Vec2[]) => Math.abs(signedArea(pts));
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
