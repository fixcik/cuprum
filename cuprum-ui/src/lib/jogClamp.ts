/** Below this magnitude (mm) a clamped jog is treated as a no-op (already parked
 *  at the edge), so we don't emit a zero-distance move. */
export const MIN_JOG_MM = 0.001;

/** Pull-off (mm) kept between a continuous jog's target and the bounds edge. A
 *  continuous jog aims at the edge from the live MPos; targeting it *exactly*
 *  lets the f64→GRBL-f32 round-trip land the target on or just past the soft
 *  limit, which GRBL rejects with `error:15` ("Jog target exceeds machine
 *  travel") — so the move never starts and a held direction just spams cancel.
 *  Backing the target off by this margin keeps it strictly inside the limit. */
export const JOG_EDGE_MARGIN_MM = 0.5;

/** Corrected jog delta so the resulting target (`pos + reqDelta`) stays within
 *  the inclusive range [lo, hi]. A UX safeguard layered over GRBL's own soft
 *  limits — shared by the manual jog pad and the drill Z touch-off card. */
export function clampJogDelta(reqDelta: number, pos: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, pos + reqDelta)) - pos;
}

export type JogBoundsTuple = { x: [number, number]; y: [number, number]; z: [number, number] };

/** Distance (mm) a continuous (hold-to-move) jog may travel from the live MPos
 *  toward the bounds edge along `dir` (sign per axis, 0 = inactive). For a
 *  diagonal it's the *smallest* per-axis room so motion stays on a true 45° line
 *  and inside the bounds on every axis. A `margin` (default {@link
 *  JOG_EDGE_MARGIN_MM}) is held back from the edge so the target can't land on
 *  the soft limit (see that constant). Returns 0 when there's no room or no
 *  active axis (the caller skips any sub-threshold result as a no-op). */
export function continuousJogRoom(
  dir: [number, number, number],
  mpos: readonly [number, number, number],
  b: JogBoundsTuple,
  margin = JOG_EDGE_MARGIN_MM,
): number {
  const [sx, sy, sz] = dir;
  const roomX = sx > 0 ? b.x[1] - mpos[0] : sx < 0 ? mpos[0] - b.x[0] : Infinity;
  const roomY = sy > 0 ? b.y[1] - mpos[1] : sy < 0 ? mpos[1] - b.y[0] : Infinity;
  const roomZ = sz > 0 ? b.z[1] - mpos[2] : sz < 0 ? mpos[2] - b.z[0] : Infinity;
  const room = Math.min(
    sx !== 0 ? Math.max(0, roomX) : Infinity,
    sy !== 0 ? Math.max(0, roomY) : Infinity,
    sz !== 0 ? Math.max(0, roomZ) : Infinity,
  );
  if (!Number.isFinite(room)) return 0;
  return Math.max(0, room - margin);
}
