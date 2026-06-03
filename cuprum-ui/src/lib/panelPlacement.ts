/** Phase 1 stop-gap placement: tuck a board into the bottom-left corner with a
 *  fixed margin, cascading by the number already placed so repeated adds don't
 *  perfectly overlap. Replaced by the nesting packer in Phase 2. All mm. */
export function placeInCorner(opts: {
  panelW: number;
  panelH: number;
  boardW: number;
  boardH: number;
  count: number;
  marginMm?: number;
  stepMm?: number;
}): { x: number; y: number } {
  const margin = opts.marginMm ?? 5;
  const step = opts.stepMm ?? 2;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const x = clamp(margin + opts.count * step, 0, Math.max(0, opts.panelW - opts.boardW));
  const y = clamp(
    opts.panelH - margin - opts.boardH - opts.count * step,
    0,
    Math.max(0, opts.panelH - opts.boardH),
  );
  return { x, y };
}

/** Axis-aligned bounding box (mm) of a placed board after Konva-style rotation
 *  about its origin (the instance's top-left corner). Konva rotates clockwise in
 *  screen coordinates (y-down), so a local corner (lx, ly) maps to
 *  (x0 + lx·cosθ − ly·sinθ, y0 + lx·sinθ + ly·cosθ). */
export function instanceBounds(opts: {
  xMm: number;
  yMm: number;
  boardW: number;
  boardH: number;
  rotationDeg: number;
}): { minX: number; minY: number; maxX: number; maxY: number } {
  const { xMm, yMm, boardW, boardH, rotationDeg } = opts;
  const rad = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const corners = [
    [0, 0],
    [boardW, 0],
    [0, boardH],
    [boardW, boardH],
  ];
  const xs = corners.map(([lx, ly]) => xMm + lx * cos - ly * sin);
  const ys = corners.map(([lx, ly]) => yMm + lx * sin + ly * cos);
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
