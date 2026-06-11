/** Rescale a motion-time estimate to a live GRBL feed override. Pure — unit-tested.
 *
 *  Feed override (the "Подача" slider) scales only feed-limited moves (G1 plunge), not
 *  rapids (G0 traverse/retract/homing). So split the estimate into its feed share
 *  (`feedSec`, which scales ~`1/override`) and the rest (rapid, unchanged):
 *
 *      scaled = (motionSec − feedSec) + feedSec / (overridePct / 100)
 *
 *  At 100% this returns `motionSec` unchanged. A 0 or negative override (shouldn't
 *  happen — GRBL floors at 10%) is treated as no scaling, to avoid divide-by-zero.
 *
 *  @param motionSec total motion time (s) at nominal 100% feed.
 *  @param feedSec   the feed-limited share of `motionSec` (≤ motionSec).
 *  @param overridePct feed override in percent (e.g. 100, 150, 40). */
export function scaledMotionSec(
  motionSec: number,
  feedSec: number,
  overridePct: number,
): number {
  const k = overridePct / 100;
  if (k <= 0) return motionSec;
  const feed = Math.max(0, Math.min(feedSec, motionSec));
  const rapid = motionSec - feed;
  return rapid + feed / k;
}
