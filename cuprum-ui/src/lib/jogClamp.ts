/** Below this magnitude (mm) a clamped jog is treated as a no-op (already parked
 *  at the edge), so we don't emit a zero-distance move. */
export const MIN_JOG_MM = 0.001;

/** Corrected jog delta so the resulting target (`pos + reqDelta`) stays within
 *  the inclusive range [lo, hi]. A UX safeguard layered over GRBL's own soft
 *  limits — shared by the manual jog pad and the drill Z touch-off card. */
export function clampJogDelta(reqDelta: number, pos: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, pos + reqDelta)) - pos;
}
