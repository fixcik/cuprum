import { useCallback, useEffect, useRef, useState } from "react";
import { nextMaxFraction } from "@/lib/drillProgress";

/** Returns a smoothed 0..1 depth-progress fraction for the hole currently being drilled.
 *  - Monotonic per hole: the ring never shrinks while the bit is in the material.
 *  - Eased via rAF: the displayed value approaches the target at a fixed blend per frame.
 *  - The easing loop self-stops once settled and re-starts on a new sample, so it does
 *    not spin idle.
 *  - Resets to 0 (immediately) when the active hole index changes or the run is inactive. */
export function useDrillProgressRing(args: {
  active: boolean;
  currentHoleIndex: number | null;
  zMm: number | null;
  targetDepthMm: number;
}): number {
  const { active, currentHoleIndex, zMm, targetDepthMm } = args;

  // Refs hold mutable state that must not trigger re-renders on every rAF tick.
  const maxFractionRef = useRef(0); // monotonic high-water mark for the current hole
  const targetRef = useRef(0); // latest monotonic progress (what the ring aims for)
  const displayedRef = useRef(0); // smoothed value being rendered
  const holeIndexRef = useRef<number | null>(null); // hole index from the last sample
  const rafRef = useRef<number | null>(null);

  const [displayed, setDisplayed] = useState(0);

  // Start the easing loop if it is not already running. The loop self-stops once
  // the displayed value reaches the target, so there is no idle 60fps spin.
  const kick = useCallback(() => {
    if (rafRef.current !== null) return;
    const EASE = 0.2;
    const tick = () => {
      const target = targetRef.current;
      const prev = displayedRef.current;
      const next = prev + (target - prev) * EASE;
      // Snap to target when close enough to avoid an infinite approach.
      const snapped = Math.abs(next - target) < 0.001 ? target : next;
      if (snapped !== prev) {
        displayedRef.current = snapped;
        setDisplayed(snapped);
      }
      rafRef.current = snapped !== target ? requestAnimationFrame(tick) : null;
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  // Fold each new Z sample into the monotonic max and update the target.
  useEffect(() => {
    if (!active || currentHoleIndex === null) {
      // Run stopped, paused, or awaiting tool change — reset and stop animating.
      maxFractionRef.current = 0;
      targetRef.current = 0;
      holeIndexRef.current = null;
      displayedRef.current = 0;
      setDisplayed(0);
      return;
    }

    // New hole started — reset the monotonic max AND snap the displayed value to 0
    // so the previous (full) hole's ring does not briefly ease onto the new hole.
    if (currentHoleIndex !== holeIndexRef.current) {
      maxFractionRef.current = 0;
      targetRef.current = 0;
      holeIndexRef.current = currentHoleIndex;
      displayedRef.current = 0;
      setDisplayed(0);
    }

    if (zMm !== null) {
      maxFractionRef.current = nextMaxFraction(maxFractionRef.current, zMm, targetDepthMm);
      targetRef.current = maxFractionRef.current;
    }

    kick();
  }, [active, currentHoleIndex, zMm, targetDepthMm, kick]);

  // Cancel any in-flight frame on unmount.
  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return active ? displayed : 0;
}
