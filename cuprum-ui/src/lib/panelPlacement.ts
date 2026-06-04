import type { NestSettings } from "@/lib/nest";

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
  /** Top-left positions of each placed board, in panel mm. */
  placements: { x: number; y: number }[];
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
  let bw = boardWmm;
  let bh = boardHmm;
  if (nest.enabled && nest.rotate) {
    const t = bw;
    bw = bh;
    bh = t;
  }
  // Edge margin and inter-board gap are auto-nesting parameters. With nesting
  // off ("one copy snug in the corner") neither applies: the single copy sits
  // flush in the corner, so it stays placeable whenever the board fits the raw
  // panel — not gated by an edge inset (board + 2·margin > panel).
  const margin = nest.enabled ? nest.marginMm : 0;
  const gap = nest.enabled ? nest.gapMm : 0;
  const innerW = panelWmm - 2 * margin;
  const innerH = panelHmm - 2 * margin;
  const cols =
    bw + gap > 0
      ? Math.max(0, Math.floor((innerW + gap) / (bw + gap)))
      : 0;
  const rows =
    bh + gap > 0
      ? Math.max(0, Math.floor((innerH + gap) / (bh + gap)))
      : 0;
  const max = cols * rows;

  let requested: number;
  if (!nest.enabled) requested = 1;
  else if (nest.fillMode === "copies") requested = nest.copies;
  else requested = Math.floor((max * nest.fillPct) / 100);

  const n = Math.max(0, Math.min(requested, max));

  const placements: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    let r: number;
    let c: number;
    if (nest.enabled && nest.dir === "cols") {
      c = Math.floor(i / Math.max(1, rows));
      r = i % Math.max(1, rows);
    } else {
      r = Math.floor(i / Math.max(1, cols));
      c = i % Math.max(1, cols);
    }
    // Anchor to the chosen corner.
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
    placements.push({ x, y });
  }
  return { bw, bh, cols, rows, max, requested, n, placements };
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
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    [xMm, yMm],
    [xMm + boardW, yMm],
    [xMm, yMm + boardH],
    [xMm + boardW, yMm + boardH],
  ];
  const xs = corners.map(([px, py]) => cx + (px - cx) * cos - (py - cy) * sin);
  const ys = corners.map(([px, py]) => cy + (px - cx) * sin + (py - cy) * cos);
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

export type Box = { minX: number; minY: number; maxX: number; maxY: number };

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
