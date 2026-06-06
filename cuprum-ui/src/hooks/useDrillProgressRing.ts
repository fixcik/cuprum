import { useEffect, useRef, useState } from "react";
import { nextMaxFraction } from "@/lib/drillProgress";

/** Returns a smoothed 0..1 depth-progress fraction for the hole currently being drilled.
 *  - Monotonic per hole: the ring never shrinks while the bit is in the material.
 *  - Eased via rAF: displayed value approaches the target at a fixed blend factor each frame.
 *  - Resets to 0 when the active hole index changes or when the run is not active. */
export function useDrillProgressRing(args: {
  active: boolean;
  currentHoleIndex: number | null;
  zMm: number | null;
  targetDepthMm: number;
}): number {
  const { active, currentHoleIndex, zMm, targetDepthMm } = args;

  // Refs hold mutable state that must not trigger re-renders on every rAF tick.
  const maxFractionRef = useRef(0);   // monotonic high-water mark for the current hole
  const targetRef = useRef(0);        // latest monotonic progress (what the ring aims for)
  const displayedRef = useRef(0);     // smoothed value being rendered
  const holeIndexRef = useRef<number | null>(null); // hole index from the last sample

  const [displayed, setDisplayed] = useState(0);
  const rafRef = useRef<number | null>(null);

  // Feed each new Z sample into the monotonic max and update the target ref.
  useEffect(() => {
    if (!active || currentHoleIndex === null) {
      // Run stopped or paused — reset everything immediately.
      maxFractionRef.current = 0;
      targetRef.current = 0;
      holeIndexRef.current = null;
      return;
    }

    // New hole started — reset the monotonic max so the ring starts from 0.
    if (currentHoleIndex !== holeIndexRef.current) {
      maxFractionRef.current = 0;
      holeIndexRef.current = currentHoleIndex;
    }

    if (zMm !== null) {
      maxFractionRef.current = nextMaxFraction(maxFractionRef.current, zMm, targetDepthMm);
      targetRef.current = maxFractionRef.current;
    }
  }, [active, currentHoleIndex, zMm, targetDepthMm]);

  // rAF easing loop: blend displayed toward target each frame, update React state.
  useEffect(() => {
    const EASE = 0.2;

    function tick() {
      const target = active ? targetRef.current : 0;
      const prev = displayedRef.current;
      const next = prev + (target - prev) * EASE;
      // Snap to target when close enough to avoid infinite approach.
      const snapped = Math.abs(next - target) < 0.001 ? target : next;

      if (snapped !== prev) {
        displayedRef.current = snapped;
        setDisplayed(snapped);
      }

      rafRef.current = requestAnimationFrame(tick);
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [active]);

  // When inactive, ensure we return 0 (the rAF will ease it down, but on first
  // render after deactivation we want an immediate zero guarantee).
  return active ? displayed : 0;
}
