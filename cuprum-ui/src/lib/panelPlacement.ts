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
