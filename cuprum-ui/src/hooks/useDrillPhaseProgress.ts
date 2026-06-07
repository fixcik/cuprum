import { useCallback, useEffect, useRef, useState } from "react";
import {
  nextPhaseProgress,
  ZERO_PHASE_PROGRESS,
  type DrillHolePhase,
  type PhaseProgress,
} from "@/lib/drillPhaseProgress";

/** Returns smoothed three-phase progress for the hole currently being drilled.
 *  - Monotonic per hole: no phase fraction shrinks while in the material.
 *  - Each phase fraction is eased via rAF toward its latest target.
 *  - The easing loop self-stops once settled and re-starts on a new sample.
 *  - Resets to zero when the active hole index changes or the run is inactive.
 *
 *  Tracks descent/drilling/retract separately so the ring can render three
 *  coloured segments. */
export function useDrillPhaseProgress(args: {
  active: boolean;
  currentHoleIndex: number | null;
  zMm: number | null;
  depthMm: number;
  safeZMm: number;
}): PhaseProgress {
  const { active, currentHoleIndex, zMm, depthMm, safeZMm } = args;

  // Monotonic per-hole truth (what the ring eases toward) and the phase label.
  const truthRef = useRef<PhaseProgress>(ZERO_PHASE_PROGRESS);
  // Smoothed fractions being rendered.
  const dispRef = useRef({ descent: 0, drilling: 0, retract: 0 });
  const holeIndexRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  // Track the last pushed phase so a label-only change still re-renders.
  const displayedPhaseRef = useRef<DrillHolePhase>("traverse");

  const [displayed, setDisplayed] = useState<PhaseProgress>(ZERO_PHASE_PROGRESS);

  // Ease each fraction toward the monotonic truth. Self-stops when all settled.
  const kick = useCallback(() => {
    if (rafRef.current !== null) return;
    const EASE = 0.2;
    const tick = () => {
      const t = truthRef.current;
      const d = dispRef.current;
      const blend = (prev: number, target: number) => {
        const next = prev + (target - prev) * EASE;
        return Math.abs(next - target) < 0.001 ? target : next;
      };
      const nd = blend(d.descent, t.descent);
      const ndr = blend(d.drilling, t.drilling);
      const nr = blend(d.retract, t.retract);
      const settled = nd === t.descent && ndr === t.drilling && nr === t.retract;
      if (nd !== d.descent || ndr !== d.drilling || nr !== d.retract) {
        dispRef.current = { descent: nd, drilling: ndr, retract: nr };
        setDisplayed({ phase: t.phase, descent: nd, drilling: ndr, retract: nr });
      } else if (t.phase !== displayedPhaseRef.current) {
        // Fractions settled but the phase label changed — push it through.
        setDisplayed({ phase: t.phase, ...dispRef.current });
      }
      displayedPhaseRef.current = t.phase;
      rafRef.current = settled ? null : requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    if (!active || currentHoleIndex === null) {
      truthRef.current = ZERO_PHASE_PROGRESS;
      dispRef.current = { descent: 0, drilling: 0, retract: 0 };
      holeIndexRef.current = null;
      displayedPhaseRef.current = "traverse";
      setDisplayed(ZERO_PHASE_PROGRESS);
      return;
    }

    // New hole — reset truth and snap the displayed value to 0 so the previous
    // (full) hole's ring does not briefly ease onto the new hole.
    if (currentHoleIndex !== holeIndexRef.current) {
      truthRef.current = ZERO_PHASE_PROGRESS;
      dispRef.current = { descent: 0, drilling: 0, retract: 0 };
      holeIndexRef.current = currentHoleIndex;
      displayedPhaseRef.current = "traverse";
      setDisplayed(ZERO_PHASE_PROGRESS);
    }

    if (zMm !== null) {
      truthRef.current = nextPhaseProgress(truthRef.current, zMm, depthMm, safeZMm);
    }

    kick();
  }, [active, currentHoleIndex, zMm, depthMm, safeZMm, kick]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  return active ? displayed : ZERO_PHASE_PROGRESS;
}
