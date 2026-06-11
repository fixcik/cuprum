import type { NestSettings } from "@/lib/nest";
import type { BoardInstance, KeepOutZone, ToolingHole, ToolingHoleRole } from "@/lib/api";

/** Axis-aligned bounding box (mm). */
export type Box = { minX: number; minY: number; maxX: number; maxY: number };

/** Result of packing a board into a panel under a nesting recipe. All mm. */
export interface PackResult {
  /** Effective board footprint after optional 90° rotation. */
  bw: number;
  bh: number;
  cols: number;
  rows: number;
  /** Maximum boards that fit (cols * rows). */
  max: number;
  /** How many were requested (1 when disabled; copies; or fill-percentage count). */
  requested: number;
  /** Actually placed = clamp(requested, 0, max). overflow = requested > max. */
  n: number;
  /** Top-left of each placed footprint, in panel mm, with its 90° flag. The grid
   *  path sets one flag for all (= nest.rotate); MaxRects sets it per board. */
  placements: { x: number; y: number; rotated: boolean }[];
}

/** Strict AABB overlap (touching edges do not count) with a float tolerance. */
export function boxesOverlap(a: Box, b: Box, tol = 1e-6): boolean {
  return a.minX < b.maxX - tol && a.maxX > b.minX + tol && a.minY < b.maxY - tol && a.maxY > b.minY + tol;
}

/** Minimum keep-out zone side (mm). */
export const KEEPOUT_MIN_MM = 1;

/** Normalise a (possibly negative-size) zone rect to positive w/h, clamp it into
 *  [0,W]×[0,H] trimming BOTH edges, and enforce a minimum size. Authoritative
 *  geometry guard shared by add + resize of keep-out zones. */
export function clampZoneRect(
  rect: { x_mm: number; y_mm: number; width_mm: number; height_mm: number },
  panelW: number,
  panelH: number,
  minMm: number,
): { x_mm: number; y_mm: number; width_mm: number; height_mm: number } {
  const nx = rect.width_mm < 0 ? rect.x_mm + rect.width_mm : rect.x_mm;
  const ny = rect.height_mm < 0 ? rect.y_mm + rect.height_mm : rect.y_mm;
  const nw = Math.abs(rect.width_mm);
  const nh = Math.abs(rect.height_mm);
  let cx = Math.max(0, Math.min(nx, panelW));
  let cy = Math.max(0, Math.min(ny, panelH));
  let cw = Math.min(nx + nw, panelW) - cx;
  let ch = Math.min(ny + nh, panelH) - cy;
  if (cw < minMm) { cw = Math.min(minMm, panelW); cx = Math.min(cx, panelW - cw); }
  if (ch < minMm) { ch = Math.min(minMm, panelH); cy = Math.min(cy, panelH - ch); }
  return { x_mm: cx, y_mm: cy, width_mm: cw, height_mm: ch };
}

/** Pack `nest` copies of a board into a panel, avoiding `obstacles` (existing
 *  instances' AABBs, tooling holes, keep-out / clamp zones — all mm). Hybrid:
 *
 *  - **No obstacles** and either single orientation OR the grid already places
 *    everything requested → exact even grid (the predictable look, parity with the
 *    old behaviour). `cols/rows/max/requested` come from the single-orientation grid.
 *  - **Otherwise** (obstacles present, or mixed orientation could fit more) →
 *    {@link packMaxRects}: a dense MaxRects pack with per-board 90° rotation that
 *    weaves around obstacles. `cols/rows/max` stay the grid reference (so fill-%
 *    capacity and overflow reporting are unchanged); `n`/`placements` come from it.
 */
export function packLayoutAvoiding(
  boardWmm: number,
  boardHmm: number,
  panelWmm: number,
  panelHmm: number,
  nest: NestSettings,
  obstacles: Box[] = [],
  clearanceMm = 0,
): PackResult {
  let bw = boardWmm;
  let bh = boardHmm;
  if (nest.enabled && nest.rotate) {
    const t = bw;
    bw = bh;
    bh = t;
  }
  const margin = nest.enabled ? nest.marginMm : 0;
  const gap = nest.enabled ? nest.gapMm : 0;
  const innerW = panelWmm - 2 * margin;
  const innerH = panelHmm - 2 * margin;
  const cols = bw + gap > 0 ? Math.max(0, Math.floor((innerW + gap) / (bw + gap))) : 0;
  const rows = bh + gap > 0 ? Math.max(0, Math.floor((innerH + gap) / (bh + gap))) : 0;
  const max = cols * rows;

  let requested: number;
  if (!nest.enabled) requested = 1;
  else if (nest.fillMode === "copies") requested = nest.copies;
  else requested = Math.floor((max * nest.fillPct) / 100);

  // Clean even grid (single orientation per nest.rotate) — the predictable look.
  const gridResult = (): PackResult => {
    const rotatedFlag = nest.enabled && nest.rotate;
    const placements: { x: number; y: number; rotated: boolean }[] = [];
    for (let i = 0; i < max && placements.length < requested; i++) {
      let r: number;
      let c: number;
      if (nest.enabled && nest.dir === "cols") {
        c = Math.floor(i / Math.max(1, rows));
        r = i % Math.max(1, rows);
      } else {
        r = Math.floor(i / Math.max(1, cols));
        c = i % Math.max(1, cols);
      }
      let x =
        nest.corner === "tr" || nest.corner === "br"
          ? panelWmm - margin - (c + 1) * bw - c * gap
          : margin + c * (bw + gap);
      let y =
        nest.corner === "bl" || nest.corner === "br"
          ? panelHmm - margin - (r + 1) * bh - r * gap
          : margin + r * (bh + gap);
      if (nest.enabled && nest.snapMm > 0) {
        x = Math.round(x / nest.snapMm) * nest.snapMm;
        y = Math.round(y / nest.snapMm) * nest.snapMm;
      }
      placements.push({ x, y, rotated: rotatedFlag });
    }
    return { bw, bh, cols, rows, max, requested, n: placements.length, placements };
  };

  // No obstacles: a single-orientation grid is optimal. Use it unless the user wants
  // mixed orientation AND the grid couldn't already place everything requested (then
  // MaxRects may fit more by rotating individual boards).
  if (obstacles.length === 0) {
    const grid = gridResult();
    if (!nest.mixRotation || grid.n >= requested) return grid;
  }

  // Obstacles present, or mixed orientation could help → dense MaxRects pack.
  const runPack = (mix: boolean, force: boolean) =>
    packMaxRects({
      boardW: boardWmm,
      boardH: boardHmm,
      panelW: panelWmm,
      panelH: panelHmm,
      requested,
      marginMm: margin,
      gapMm: gap,
      clearanceMm,
      corner: nest.corner,
      mixRotation: mix,
      forceRotate: force,
      obstacles,
    });
  let placements: { x: number; y: number; rotated: boolean }[];
  if (nest.enabled && nest.mixRotation) {
    // Best-of: a greedy per-board heuristic can fragment space and underperform a
    // uniform layout, so try all-0°, all-90° and mixed, keep the fullest. `reduce`
    // keeps the first max → uniform 0° wins ties (the tidiest look).
    placements = [runPack(false, false), runPack(false, true), runPack(true, false)].reduce(
      (best, c) => (c.length > best.length ? c : best),
    );
  } else {
    placements = runPack(false, nest.enabled && nest.rotate);
  }
  return { bw: boardWmm, bh: boardHmm, cols, rows, max, requested, n: placements.length, placements };
}

/** MaxRects rectangle packer (best-short-side-fit) with 90° rotation and obstacle
 *  seeding. Pure and deterministic (stable free-list order, fixed tie-breaks; no
 *  Math.random). Returns the placed footprints' top-left + rotation flag, capped at
 *  `requested`. Used by {@link packLayoutAvoiding} when a plain grid won't do.
 *
 *  - Free rectangles seed = panel inset by `marginMm`, minus every obstacle inflated
 *    by `clearanceMm` (callers pass the board gap as clearance — matches the legacy
 *    uniform inflation).
 *  - Each placed copy is subtracted inflated by `gapMm`, so neighbours keep ≥ gap.
 *  - `corner` is the anchor: a copy hugs that corner of its chosen free rect, and
 *    ties break toward that panel corner.
 *  - Orientations tried: `mixRotation` → [0°, 90°]; else only `forceRotate`'s one. */
export function packMaxRects(p: {
  boardW: number;
  boardH: number;
  panelW: number;
  panelH: number;
  requested: number;
  marginMm: number;
  gapMm: number;
  clearanceMm: number;
  corner: NestSettings["corner"];
  mixRotation: boolean;
  forceRotate: boolean;
  obstacles: Box[];
}): { x: number; y: number; rotated: boolean }[] {
  const {
    boardW, boardH, panelW, panelH, requested, marginMm, gapMm, clearanceMm,
    corner, mixRotation, forceRotate, obstacles,
  } = p;
  if (requested <= 0) return [];
  const EPS = 1e-6;
  const anchorLeft = corner === "tl" || corner === "bl";
  const anchorTop = corner === "tl" || corner === "tr";

  const inflate = (b: Box, by: number): Box => ({
    minX: b.minX - by, minY: b.minY - by, maxX: b.maxX + by, maxY: b.maxY + by,
  });
  const area = (b: Box): number => (b.maxX - b.minX) * (b.maxY - b.minY);
  const contains = (b: Box, a: Box): boolean =>
    b.minX <= a.minX + EPS && b.minY <= a.minY + EPS && b.maxX >= a.maxX - EPS && b.maxY >= a.maxY - EPS;

  // Free-rectangle list, seeded with the margin-inset panel.
  let free: Box[] = [];
  const inner: Box = { minX: marginMm, minY: marginMm, maxX: panelW - marginMm, maxY: panelH - marginMm };
  if (inner.maxX - inner.minX > EPS && inner.maxY - inner.minY > EPS) free.push(inner);

  // Remove `cut` from every overlapped free rect (split into ≤4 slabs), then prune
  // any rect fully contained in another (keeps the set near-maximal and bounded).
  const subtract = (cut: Box): void => {
    const next: Box[] = [];
    for (const f of free) {
      if (!boxesOverlap(f, cut)) { next.push(f); continue; }
      if (cut.minX > f.minX + EPS) next.push({ minX: f.minX, minY: f.minY, maxX: cut.minX, maxY: f.maxY });
      if (cut.maxX < f.maxX - EPS) next.push({ minX: cut.maxX, minY: f.minY, maxX: f.maxX, maxY: f.maxY });
      if (cut.minY > f.minY + EPS) next.push({ minX: f.minX, minY: f.minY, maxX: f.maxX, maxY: cut.minY });
      if (cut.maxY < f.maxY - EPS) next.push({ minX: f.minX, minY: cut.maxY, maxX: f.maxX, maxY: f.maxY });
    }
    // Prune a when some other b contains it and is strictly larger, or equal-and-earlier
    // (so identical duplicate rects don't mutually delete each other).
    free = next.filter((a, i) =>
      !next.some((b, j) => i !== j && contains(b, a) && (area(b) > area(a) + EPS || j < i)));
  };

  for (const o of obstacles) subtract(inflate(o, clearanceMm));

  const orients = mixRotation ? [false, true] : [forceRotate];
  const out: { x: number; y: number; rotated: boolean }[] = [];
  for (let k = 0; k < requested; k++) {
    let best: { x: number; y: number; rotated: boolean; s1: number; s2: number; bias: number } | null = null;
    for (const f of free) {
      const fw = f.maxX - f.minX;
      const fh = f.maxY - f.minY;
      for (const rotated of orients) {
        const bw = rotated ? boardH : boardW;
        const bh = rotated ? boardW : boardH;
        if (bw > fw + EPS || bh > fh + EPS) continue;
        const x = anchorLeft ? f.minX : f.maxX - bw;
        const y = anchorTop ? f.minY : f.maxY - bh;
        const leftoverW = fw - bw;
        const leftoverH = fh - bh;
        const s1 = Math.min(leftoverW, leftoverH); // best short-side fit
        const s2 = Math.max(leftoverW, leftoverH); // tie: best long-side fit
        const ax = anchorLeft ? x : panelW - (x + bw);
        const ay = anchorTop ? y : panelH - (y + bh);
        const bias = ax + ay; // tie: hug the anchor corner
        const better =
          best === null ||
          s1 < best.s1 - EPS ||
          (Math.abs(s1 - best.s1) <= EPS &&
            (s2 < best.s2 - EPS ||
              (Math.abs(s2 - best.s2) <= EPS && bias < best.bias - EPS)));
        if (better) best = { x, y, rotated, s1, s2, bias };
      }
    }
    if (!best) break;
    out.push({ x: best.x, y: best.y, rotated: best.rotated });
    const bw = best.rotated ? boardH : boardW;
    const bh = best.rotated ? boardW : boardH;
    subtract(inflate({ minX: best.x, minY: best.y, maxX: best.x + bw, maxY: best.y + bh }, gapMm));
  }
  return out;
}

/** Grid-pack `nest` copies of a board into a panel, anchored to a corner.
 *  Identical rectangles only (real heterogeneous nesting is a later task). */
export function packLayout(
  boardWmm: number,
  boardHmm: number,
  panelWmm: number,
  panelHmm: number,
  nest: NestSettings,
): PackResult {
  return packLayoutAvoiding(boardWmm, boardHmm, panelWmm, panelHmm, nest, [], 0);
}

/** Rotate point (px,py) about center (cx,cy) by `rotationDeg` (degrees, CCW in
 *  the panel's Y-down space). Shared by instanceBounds and panel-drill projection
 *  so a placed board's holes land exactly on its drawn footprint. */
export function rotatePointAroundCenter(
  px: number,
  py: number,
  cx: number,
  cy: number,
  rotationDeg: number,
): [number, number] {
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [cx + (px - cx) * cos - (py - cy) * sin, cy + (px - cx) * sin + (py - cy) * cos];
}

/** Axis-aligned bounding box (mm) of a placed board. `(x, y)` is the top-left of
 *  the UNROTATED board; `rotation_deg` is an arbitrary angle about the board
 *  CENTRE (`cx = x + W/2`, `cy = y + H/2`). The four corners are rotated about the
 *  centre and min/max'd — a true rotated-quad AABB (the right-angle cases are just
 *  special values). This is the single pose model shared by packLayout, the canvas
 *  (Konva rotation about centre) and the off-panel / clamp checks. */
export function instanceBounds(opts: {
  xMm: number;
  yMm: number;
  boardW: number;
  boardH: number;
  rotationDeg: number;
}): { minX: number; minY: number; maxX: number; maxY: number } {
  const { xMm, yMm, boardW, boardH, rotationDeg } = opts;
  const cx = xMm + boardW / 2;
  const cy = yMm + boardH / 2;
  const corners: [number, number][] = [
    [xMm, yMm],
    [xMm + boardW, yMm],
    [xMm, yMm + boardH],
    [xMm + boardW, yMm + boardH],
  ];
  const rotated = corners.map(([px, py]) => rotatePointAroundCenter(px, py, cx, cy, rotationDeg));
  const xs = rotated.map((p) => p[0]);
  const ys = rotated.map((p) => p[1]);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** True if a placed board pokes outside the panel rectangle [0,panelW]×[0,panelH].
 *  Used to warn (not block) when shrinking the blank leaves a design hanging off
 *  the edge. The tolerance absorbs float noise so a board flush with the edge
 *  isn't flagged. All mm. */
export function isOffPanel(opts: {
  xMm: number;
  yMm: number;
  boardW: number;
  boardH: number;
  rotationDeg: number;
  panelW: number;
  panelH: number;
  tolMm?: number;
}): boolean {
  const tol = opts.tolMm ?? 1e-3;
  const b = instanceBounds(opts);
  return b.minX < -tol || b.minY < -tol || b.maxX > opts.panelW + tol || b.maxY > opts.panelH + tol;
}

/** Clamp a move delta (mm) so every supplied AABB stays within [0,panelW]×[0,panelH].
 *  Clamps each axis to the tightest bound across all boxes. */
export function clampDeltaToPanel(
  boxes: Box[],
  dxMm: number,
  dyMm: number,
  panelW: number,
  panelH: number,
): { dx: number; dy: number } {
  let dx = dxMm;
  let dy = dyMm;
  for (const b of boxes) {
    if (b.minX + dx < 0) dx = -b.minX;
    if (b.maxX + dx > panelW) dx = panelW - b.maxX;
    if (b.minY + dy < 0) dy = -b.minY;
    if (b.maxY + dy > panelH) dy = panelH - b.maxY;
  }
  return { dx, dy };
}

/** Shift a single instance pose so its (rotated) AABB sits fully inside the panel
 *  [0,panelW]×[0,panelH]; an already-inside pose is returned unchanged. Used by the
 *  numeric placement inspector so typed X/Y/rotation can't push a board off-panel
 *  (same clamp the drag/nudge paths use). Returns the corrected top-left origin. */
export function clampPoseIntoPanel(
  pose: { x_mm: number; y_mm: number; rotation_deg: number },
  boardW: number,
  boardH: number,
  panelW: number,
  panelH: number,
): { x_mm: number; y_mm: number } {
  const b = instanceBounds({ xMm: pose.x_mm, yMm: pose.y_mm, boardW, boardH, rotationDeg: pose.rotation_deg });
  const { dx, dy } = clampDeltaToPanel([b], 0, 0, panelW, panelH);
  return { x_mm: pose.x_mm + dx, y_mm: pose.y_mm + dy };
}

/** Build rotated-AABB boxes for instances whose board size is known. Instances
 *  with no resolved size are skipped (their extents are unknown). Shared by the
 *  drag, nudge and duplicate clamp paths so they agree on geometry. */
export function boxesForInstances(
  instances: { design_id: string; x_mm: number; y_mm: number; rotation_deg: number }[],
  sizes: Record<string, { w: number; h: number }>,
): Box[] {
  const boxes: Box[] = [];
  for (const i of instances) {
    const sz = sizes[i.design_id];
    if (!sz) continue;
    boxes.push(
      instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: i.rotation_deg }),
    );
  }
  return boxes;
}

/** Ids whose AABB intersects the marquee rect (mm). */
export function marqueeHits(items: { id: string; box: Box }[], rect: Box): string[] {
  return items
    .filter(({ box }) =>
      box.minX <= rect.maxX && box.maxX >= rect.minX && box.minY <= rect.maxY && box.maxY >= rect.minY,
    )
    .map(({ id }) => id);
}

/** Nine snap points of a box (mm): four corners, four edge midpoints, centre.
 *  Order: TL, TR, BL, BR, top-mid, bottom-mid, left-mid, right-mid, centre. */
function boxNinePoints(b: Box): { x: number; y: number }[] {
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return [
    { x: b.minX, y: b.minY }, { x: b.maxX, y: b.minY }, { x: b.minX, y: b.maxY }, { x: b.maxX, y: b.maxY },
    { x: cx, y: b.minY }, { x: cx, y: b.maxY }, { x: b.minX, y: cy }, { x: b.maxX, y: cy }, { x: cx, y: cy },
  ];
}

/** Snap candidates (panel mm) for the hover crosshair: the blank's corners / edge
 *  midpoints / centre, plus the same nine points of every supplied instance's
 *  (rotated) AABB. Instances with no resolved size are skipped. Mirrors the design
 *  preview's feature/board snapping. */
export function buildSnapCandidates(
  panelW: number,
  panelH: number,
  instances: BoardInstance[],
  sizes: Record<string, { w: number; h: number }>,
): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  pts.push(...boxNinePoints({ minX: 0, minY: 0, maxX: panelW, maxY: panelH }));
  for (const i of instances) {
    const sz = sizes[i.design_id];
    if (!sz) continue;
    pts.push(
      ...boxNinePoints(
        instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: i.rotation_deg }),
      ),
    );
  }
  return pts;
}

/** Union AABB (mm) of the selected instances, INCLUDING the live rotation preview
 *  (`rotPreviewDeg` degrees added to each selected board's angle), so the rotation
 *  knob tracks the selection while it spins. Returns null when nothing is selected
 *  or no selected instance has a resolved size.
 *
 *  `anchorX/anchorY` is the bottom-right corner of the REAL selected board nearest
 *  the union AABB's bottom-right corner: for a multi-selection that union corner
 *  usually falls in the empty gap between boards, leaving the knob floating in the
 *  void, so pinning it to the closest actual board corner keeps it attached. Single
 *  selection: the nearest box IS the union, so this is a no-op. */
export function computeSelectionBBox(
  instances: BoardInstance[],
  selected: Set<string>,
  sizes: Record<string, { w: number; h: number }>,
  rotPreviewDeg: number | null,
): { minX: number; minY: number; maxX: number; maxY: number; anchorX: number; anchorY: number } | null {
  const boxes = instances
    .filter((i) => selected.has(i.id) && sizes[i.design_id])
    .map((i) => {
      const sz = sizes[i.design_id];
      const rot = i.rotation_deg + (rotPreviewDeg ?? 0);
      return instanceBounds({ xMm: i.x_mm, yMm: i.y_mm, boardW: sz.w, boardH: sz.h, rotationDeg: rot });
    });
  if (boxes.length === 0) return null;
  const minX = Math.min(...boxes.map((b) => b.minX));
  const minY = Math.min(...boxes.map((b) => b.minY));
  const maxX = Math.max(...boxes.map((b) => b.maxX));
  const maxY = Math.max(...boxes.map((b) => b.maxY));
  let anchorX = maxX;
  let anchorY = maxY;
  let best = Infinity;
  for (const b of boxes) {
    const d = Math.hypot(b.maxX - maxX, b.maxY - maxY);
    if (d < best) {
      best = d;
      anchorX = b.maxX;
      anchorY = b.maxY;
    }
  }
  return { minX, minY, maxX, maxY, anchorX, anchorY };
}

/** Snap an angle (deg) to 15° (default) or 1° (fine), normalised to [0,360). */
export function snapAngle(deg: number, fine: boolean): number {
  const step = fine ? 1 : 15;
  const snapped = Math.round(deg / step) * step;
  return ((snapped % 360) + 360) % 360;
}

/** Which edge/centre the selection aligns to. Mirrors the layout store's type. */
export type AlignEdge = "left" | "hcenter" | "right" | "top" | "vmiddle" | "bottom";

export type AlignItem = { id: string; x_mm: number; y_mm: number; box: Box };
type Pose = { id: string; x_mm: number; y_mm: number };

const pose = ({ id, x_mm, y_mm }: AlignItem): Pose => ({ id, x_mm, y_mm });

/** Align ≥2 instances to their shared bounding box. Each instance's x_mm/y_mm is
 *  shifted by the delta that moves its rotated AABB edge/centre onto the target;
 *  translating the centre of rotation translates the AABB by the same amount. */
export function alignInstances(items: AlignItem[], edge: AlignEdge): Pose[] {
  if (items.length < 2) return items.map(pose);
  const minX = Math.min(...items.map((i) => i.box.minX));
  const maxX = Math.max(...items.map((i) => i.box.maxX));
  const minY = Math.min(...items.map((i) => i.box.minY));
  const maxY = Math.max(...items.map((i) => i.box.maxY));
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return items.map((i) => {
    const bcx = (i.box.minX + i.box.maxX) / 2;
    const bcy = (i.box.minY + i.box.maxY) / 2;
    let dx = 0;
    let dy = 0;
    switch (edge) {
      case "left": dx = minX - i.box.minX; break;
      case "right": dx = maxX - i.box.maxX; break;
      case "hcenter": dx = cx - bcx; break;
      case "top": dy = minY - i.box.minY; break;
      case "bottom": dy = maxY - i.box.maxY; break;
      case "vmiddle": dy = cy - bcy; break;
    }
    return { id: i.id, x_mm: i.x_mm + dx, y_mm: i.y_mm + dy };
  });
}

/** A snap guide line to render while dragging. axis "x" = a vertical line at x=pos
 *  spanning y∈[from,to]; axis "y" = a horizontal line at y=pos spanning x∈[from,to].
 *  All mm. */
export type GuideLine = { axis: "x" | "y"; pos: number; from: number; to: number };

/** Magnetic alignment of a dragged selection to other boards + the panel frame.
 *  `movingBox` is the selection's AABB after the raw drag delta; `targets` are
 *  static AABBs (non-selected instances PLUS the panel box {0,0,W,H} — the panel
 *  box yields its edges and centre for free). Returns the extra delta that aligns
 *  the closest edge/centre pair within `thresholdMm` on each axis (independently),
 *  and the guide lines to draw. No match on an axis → 0 delta and no line there. */
export function computeSmartGuides(opts: {
  movingBox: Box;
  targets: Box[];
  thresholdMm: number;
}): { dx: number; dy: number; guides: GuideLine[] } {
  const { movingBox, targets, thresholdMm } = opts;
  const linesX = (b: Box) => [b.minX, (b.minX + b.maxX) / 2, b.maxX];
  const linesY = (b: Box) => [b.minY, (b.minY + b.maxY) / 2, b.maxY];
  const probesX = linesX(movingBox);
  const probesY = linesY(movingBox);

  // Best (smallest |delta|) snap on one axis across all targets.
  const bestAxis = (
    probes: number[],
    targetLines: (b: Box) => number[],
  ): { delta: number; pos: number; target: Box } | null => {
    let best: { delta: number; pos: number; target: Box } | null = null;
    for (const t of targets) {
      for (const line of targetLines(t)) {
        for (const probe of probes) {
          const d = line - probe;
          if (Math.abs(d) <= thresholdMm && (best === null || Math.abs(d) < Math.abs(best.delta))) {
            best = { delta: d, pos: line, target: t };
          }
        }
      }
    }
    return best;
  };

  const bx = bestAxis(probesX, linesX);
  const by = bestAxis(probesY, linesY);
  const dx = bx?.delta ?? 0;
  const dy = by?.delta ?? 0;

  // Span each guide across the union of the snapped moving box and the matched
  // target, so the line visibly connects the two aligned features.
  const guides: GuideLine[] = [];
  if (bx) {
    const from = Math.min(movingBox.minY + dy, bx.target.minY);
    const to = Math.max(movingBox.maxY + dy, bx.target.maxY);
    guides.push({ axis: "x", pos: bx.pos, from, to });
  }
  if (by) {
    const from = Math.min(movingBox.minX + dx, by.target.minX);
    const to = Math.max(movingBox.maxX + dx, by.target.maxX);
    guides.push({ axis: "y", pos: by.pos, from, to });
  }
  return { dx, dy, guides };
}

export type RenestTransform = { id: string; x_mm: number; y_mm: number; rotation_deg: number };

/** Re-pack a selection into tidy corner-anchored grids, one per design, each
 *  avoiding non-selected instances AND the grids already placed in this run.
 *  Mirrors addBoardInstances' centre-pivot pose for rotated copies. Only the
 *  instances that fit get a transform (placed ≤ requested). Pure. */
export function renestSelection(opts: {
  selected: { id: string; design_id: string }[];
  sizes: Record<string, { w: number; h: number }>;
  obstacles: Box[];
  panelW: number;
  panelH: number;
  nest: NestSettings;
}): { transforms: RenestTransform[]; requested: number; placed: number } {
  const { selected, sizes, obstacles, panelW, panelH, nest } = opts;
  // Group by design id, preserving first-seen order.
  const order: string[] = [];
  const groups = new Map<string, string[]>();
  for (const s of selected) {
    if (!groups.has(s.design_id)) {
      groups.set(s.design_id, []);
      order.push(s.design_id);
    }
    groups.get(s.design_id)!.push(s.id);
  }

  // groupNest forces enabled:true so the packer is active even with the persisted
  // default nest.enabled === false; the 90° flag now travels per placement (p.rotated),
  // so mixed-orientation MaxRects packs and single-orientation grids both work.
  const placedBoxes: Box[] = [];
  const transforms: RenestTransform[] = [];
  let requested = 0;
  let placed = 0;

  for (const designId of order) {
    const ids = groups.get(designId)!;
    const sz = sizes[designId];
    if (!sz) continue; // unknown size → leave this group untouched
    requested += ids.length;
    const groupNest: NestSettings = {
      ...nest,
      enabled: true,
      fillMode: "copies",
      copies: ids.length,
    };
    const pack = packLayoutAvoiding(
      sz.w, sz.h, panelW, panelH,
      groupNest,
      obstacles.concat(placedBoxes),
      nest.gapMm,
    );
    placed += pack.n;
    pack.placements.forEach((p, k) => {
      // Footprint of this (possibly rotated) copy; centre-pivot keeps the board
      // centre on the packed cell, so the rotated AABB still fills it. Mirrors
      // addBoardInstances.
      const fw = p.rotated ? sz.h : sz.w;
      const fh = p.rotated ? sz.w : sz.h;
      transforms.push({
        id: ids[k],
        x_mm: p.rotated ? p.x + (sz.h - sz.w) / 2 : p.x,
        y_mm: p.rotated ? p.y + (sz.w - sz.h) / 2 : p.y,
        rotation_deg: p.rotated ? 90 : 0,
      });
      placedBoxes.push({ minX: p.x, minY: p.y, maxX: p.x + fw, maxY: p.y + fh });
    });
  }
  return { transforms, requested, placed };
}

/** Axis-aligned bounding box (mm) for a tooling hole, centred on (xMm, yMm) with
 *  side length equal to the bore diameter. */
export function toolingHoleBounds(h: { xMm: number; yMm: number; diameterMm: number }): Box {
  const r = h.diameterMm / 2;
  return { minX: h.xMm - r, minY: h.yMm - r, maxX: h.xMm + r, maxY: h.yMm + r };
}

/** Keep the whole bore inside the panel. If the panel is smaller than the bore,
 *  centre the hole on the panel axis instead. `r` is the bore radius (mm). */
export function clampToolingHoleCenter(
  x: number,
  y: number,
  r: number,
  panelW: number,
  panelH: number,
): { x: number; y: number } {
  const cx = panelW >= 2 * r ? Math.min(panelW - r, Math.max(r, x)) : panelW / 2;
  const cy = panelH >= 2 * r ? Math.min(panelH - r, Math.max(r, y)) : panelH / 2;
  return { x: cx, y: cy };
}

/** Corner positions for a registration-hole set, inset from each edge by
 *  `marginMm` (clamped to half the shorter side so holes stay on the panel).
 *  `count` 4 → all corners (TL, TR, BL, BR); 2 → diagonal pair (TL, BR). All mm. */
export function registrationSetPositions(
  panelW: number,
  panelH: number,
  marginMm: number,
  count: 2 | 4 = 4,
): { x: number; y: number }[] {
  const mx = Math.min(marginMm, panelW / 2);
  const my = Math.min(marginMm, panelH / 2);
  const tl = { x: mx, y: my };
  const tr = { x: panelW - mx, y: my };
  const bl = { x: mx, y: panelH - my };
  const br = { x: panelW - mx, y: panelH - my };
  return count === 2 ? [tl, br] : [tl, tr, bl, br];
}

/** Unified placement-obstacle source: board instances + tooling holes + keep-out zones (raw AABBs).
 *  `packLayoutAvoiding` inflates every obstacle by its `clearance` arg uniformly,
 *  so the fixturing gap around a pin equals the board gap.
 *  When `opts.clampRadiusMm > 0`, derived clamp zones around registration/flip holes
 *  are also added as obstacles so new boards are packed outside the clamp footprint. */
export function panelObstacles(
  panel: {
    instances: BoardInstance[];
    tooling_holes: ToolingHole[];
    keep_out_zones?: KeepOutZone[];
  },
  sizes: Record<string, { w: number; h: number }>,
  opts?: { clampRadiusMm?: number },
): Box[] {
  const boards = boxesForInstances(panel.instances, sizes);
  const holes = panel.tooling_holes.map((h) =>
    toolingHoleBounds({ xMm: h.x_mm, yMm: h.y_mm, diameterMm: h.diameter_mm }),
  );
  // All keep-out zones are obstacles for the board packer.
  const zones = (panel.keep_out_zones ?? []).map(keepOutBox);
  const clamps = clampZonesForHoles(panel.tooling_holes, opts?.clampRadiusMm ?? 0).map((c) => c.box);
  return [...boards, ...holes, ...zones, ...clamps];
}

// --- Keep-out zone helpers ---

/** AABB of a keep-out zone (panel mm). */
export const keepOutBox = (z: Pick<KeepOutZone, "x_mm" | "y_mm" | "width_mm" | "height_mm">): Box => ({
  minX: z.x_mm,
  minY: z.y_mm,
  maxX: z.x_mm + z.width_mm,
  maxY: z.y_mm + z.height_mm,
});

/** Roles that carry a physical clamp/fixture field around the bore. */
const CLAMPED_ROLES: ToolingHoleRole[] = ["registration", "flip"];

/** Derived clamp keep-out boxes around tooling holes — NOT stored, computed from
 *  holes + the machine profile so they follow/remove with the hole. Empty when
 *  clampRadiusMm <= 0. Each box is an axis-aligned square centred on the hole,
 *  side = diameter + 2·radius. Carries the source hole id (render / DFM attribution). */
export function clampZonesForHoles(
  holes: ToolingHole[],
  clampRadiusMm: number,
): { holeId: string; box: Box }[] {
  if (!(clampRadiusMm > 0)) return [];
  const out: { holeId: string; box: Box }[] = [];
  for (const h of holes) {
    if (!CLAMPED_ROLES.includes(h.role)) continue;
    const half = h.diameter_mm / 2 + clampRadiusMm;
    out.push({
      holeId: h.id,
      box: { minX: h.x_mm - half, minY: h.y_mm - half, maxX: h.x_mm + half, maxY: h.y_mm + half },
    });
  }
  return out;
}

/** Evenly space ≥3 instances' AABB centres along an axis; the extreme two stay put. */
export function distributeInstances(items: AlignItem[], axis: "h" | "v"): Pose[] {
  if (items.length < 3) return items.map(pose);
  const centre = (i: AlignItem) =>
    axis === "h" ? (i.box.minX + i.box.maxX) / 2 : (i.box.minY + i.box.maxY) / 2;
  const sorted = [...items].sort((a, b) => centre(a) - centre(b));
  const c0 = centre(sorted[0]);
  const step = (centre(sorted[sorted.length - 1]) - c0) / (sorted.length - 1);
  const next = new Map<string, Pose>();
  sorted.forEach((i, idx) => {
    const target = c0 + step * idx;
    const delta = target - centre(i);
    next.set(i.id, { id: i.id, x_mm: i.x_mm + (axis === "h" ? delta : 0), y_mm: i.y_mm + (axis === "v" ? delta : 0) });
  });
  return items.map((i) => next.get(i.id)!);
}
