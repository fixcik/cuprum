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
  const innerW = panelWmm - 2 * nest.marginMm;
  const innerH = panelHmm - 2 * nest.marginMm;
  const cols =
    bw + nest.gapMm > 0
      ? Math.max(0, Math.floor((innerW + nest.gapMm) / (bw + nest.gapMm)))
      : 0;
  const rows =
    bh + nest.gapMm > 0
      ? Math.max(0, Math.floor((innerH + nest.gapMm) / (bh + nest.gapMm)))
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
        ? panelWmm - nest.marginMm - (c + 1) * bw - c * nest.gapMm
        : nest.marginMm + c * (bw + nest.gapMm);
    let y =
      nest.corner === "bl" || nest.corner === "br"
        ? panelHmm - nest.marginMm - (r + 1) * bh - r * nest.gapMm
        : nest.marginMm + r * (bh + nest.gapMm);
    if (nest.enabled && nest.snapMm > 0) {
      x = Math.round(x / nest.snapMm) * nest.snapMm;
      y = Math.round(y / nest.snapMm) * nest.snapMm;
    }
    placements.push({ x, y });
  }
  return { bw, bh, cols, rows, max, requested, n, placements };
}

/** Axis-aligned bounding box (mm) of a placed board. A placement is an
 *  axis-aligned footprint anchored at its top-left `(x, y)`: a 90°/270° instance
 *  occupies a width↔height-swapped slot, NOT a board rotated about a pivot. This
 *  matches exactly how `packLayout` positions copies and how `PanelBlankCanvas`
 *  draws them (swapped `fw`/`fh`, no Konva rotation). Rotation is therefore only
 *  the four right angles today; arbitrary angles arrive with the interactive
 *  editor and would need a true rotated-quad bbox here. */
export function instanceBounds(opts: {
  xMm: number;
  yMm: number;
  boardW: number;
  boardH: number;
  rotationDeg: number;
}): { minX: number; minY: number; maxX: number; maxY: number } {
  const { xMm, yMm, boardW, boardH, rotationDeg } = opts;
  const rot = ((rotationDeg % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const fw = swap ? boardH : boardW;
  const fh = swap ? boardW : boardH;
  return { minX: xMm, minY: yMm, maxX: xMm + fw, maxY: yMm + fh };
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
