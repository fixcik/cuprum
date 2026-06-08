/** Below this magnitude (mm) a clamped jog is treated as a no-op (already parked
 *  at the edge), so we don't emit a zero-distance move. */
export const MIN_JOG_MM = 0.001;

/** Pull-off (mm) kept between a jog target and the bounds edge. GRBL's soft-limit
 *  check is inclusive (it rejects only a target *strictly* past `[0, $13x]`), so
 *  the edge itself is reachable in principle. What forces a non-zero margin is how
 *  we estimate the work offset: an absolute (work-frame) jog target is built from
 *  `wco = MPos − WPos`, and GRBL reports those positions rounded to 3 decimals, so
 *  `wco` carries up to ~0.001 mm of error. GRBL then re-adds its own full-precision
 *  G54 offset, landing the real machine target at `edge ± ~0.001 mm`; on the wrong
 *  side that trips `error:15` ("Jog target exceeds machine travel") and the move
 *  never starts. 0.002 mm is just 2× that report-rounding error — enough to keep the
 *  target reliably inside the limit, yet only ~2 µm short of the true edge, which is
 *  below the machine's own positioning resolution (so the spindle effectively reaches
 *  the real corner). Note the 0 edge can't be widened away: GRBL's soft limit is
 *  one-sided, with `0` being the homed origin (not a $-setting) — so the move has to
 *  stay at/above it, hence a pull-off rather than a wider limit. (The dominant error
 *  term is the report rounding, not the f64→f32 residual ~1e-5 mm nor the motor step
 *  ~1e-3 mm, so the machine's steps/mm doesn't set this.) Shared by the continuous
 *  hold-jog (continuousJogRoom) and the absolute click-to-move (useJog.clampWork). */
export const JOG_EDGE_MARGIN_MM = 0.002;

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
