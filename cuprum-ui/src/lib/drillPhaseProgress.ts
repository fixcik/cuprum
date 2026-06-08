import { holeDepthFraction } from "@/lib/drillProgress";

/** Phases shown on the marker. `traverse` is the between-holes move at safe-Z (no
 *  cutting); the other three are the single hole's drilling cycle. */
export type DrillHolePhase = "traverse" | "descent" | "drilling" | "retract";

/** Per-hole, three-phase progress. Each fraction is a monotonic 0..1 high-water
 *  mark for its phase, so the ring never empties between samples or peck passes. */
export interface PhaseProgress {
  /** The phase the bit is currently in (for labels). */
  phase: DrillHolePhase;
  /** Descent: travel from safe-Z down to the surface (Z safeZ → 0). */
  descent: number;
  /** Drilling: travel from the surface to target depth (Z 0 → −depth). */
  drilling: number;
  /** Retract: travel from target depth back to safe-Z (Z −depth → safeZ). */
  retract: number;
  /** True once the bit has reached safe-Z for THIS hole. The cycle fractions
   *  (descent/drilling/retract) only start accruing afterwards — before that the
   *  bit is still getting INTO position (e.g. lifting off the surface after a
   *  tool-change probe/touch-off and traversing to the hole), which must read as
   *  `traverse`, not a (spuriously completed) descent. Optional: the smoothed,
   *  display-only value the hook renders omits it. */
  armed?: boolean;
}

/** Segment colours for the three phases (single source of truth for the ring).
 *  Handoff palette: descent cyan, drilling amber (fallback — overridden by the
 *  actual bit colour at render time), retract green. */
export const PHASE_COLORS: Record<DrillHolePhase, string> = {
  traverse: "#9aa3af", // muted slate — moving at safe-Z, not cutting
  descent: "#46e0ff", // cyan — approach to the surface
  drilling: "#fbbf24", // amber — fallback; phaseColor() prefers the bit colour
  retract: "#3fbf6f", // green — returning to safe-Z
};

/** Idle (paused / awaiting tool change) ring + label colour. */
export const IDLE_COLOR = "#8a929e";

/** Fraction of the full cycle each phase occupies on the ring (descent 28%,
 *  drilling 50%, retract 22%) — drilling reads as the main motion. Sums to 1. */
export const PHASE_WEIGHTS: Record<DrillHolePhase, number> = {
  traverse: 0, // not part of the hole cycle — the ring is empty while traversing
  descent: 0.28,
  drilling: 0.5,
  retract: 0.22,
};

/** Collapse the three monotonic phase fractions into a single 0..1 cycle
 *  progress, weighting each phase by its share of the ring. */
export function sweepFraction(p: PhaseProgress): number {
  const raw =
    PHASE_WEIGHTS.descent * p.descent +
    PHASE_WEIGHTS.drilling * p.drilling +
    PHASE_WEIGHTS.retract * p.retract;
  return raw <= 0 ? 0 : raw > 1 ? 1 : raw;
}

/** Arc colour for a phase. Drilling takes the active bit's colour; descent and
 *  retract take the handoff palette; idle overrides everything to grey. */
export function phaseColor(
  phase: DrillHolePhase,
  bitColor: string,
  idle: boolean,
): string {
  if (idle) return IDLE_COLOR;
  return phase === "drilling" ? bitColor : PHASE_COLORS[phase];
}

/** A hole that has not started: every phase empty, current phase = traverse. */
export const ZERO_PHASE_PROGRESS: PhaseProgress = {
  phase: "traverse",
  descent: 0,
  drilling: 0,
  retract: 0,
  armed: false,
};

/** Drilling must be essentially complete before any upward motion counts as the
 *  final retract — otherwise a peck cycle's intermediate G0-to-safe-Z would be
 *  mistaken for the retract phase. */
const DRILL_DONE = 0.98;

/** Tolerance band (mm) just below safe-Z treated as "at safe height": both arms
 *  the cycle and keeps descent at 0 there, so a sample that lands a hair under
 *  safe-Z (sampling/easing, or the top of the pre-drill lift) never blips a
 *  sliver of descent that would then latch and mislabel the traverse. */
const SAFE_Z_BAND_MM = 0.2;

const clamp01 = (f: number) => (f <= 0 ? 0 : f > 1 ? 1 : f);

/** Fold a new Z sample into the per-hole phase progress.
 *
 *  Work Z0 = material surface; the bit plunges to negative Z and retracts to
 *  positive safe-Z. Phases are distinguished by Z *position* (the plunge is one
 *  G1 move spanning safe-Z → −depth, so command boundaries don't help):
 *   - descent  = (safeZMm − zMm) / safeZMm   for zMm in [0, safeZMm]
 *   - drilling = −zMm / depthMm              for zMm in [−depthMm, 0]
 *   - retract  = (zMm + depthMm) / (safeZMm + depthMm), counted ONLY once
 *     drilling has reached target depth (guards peck retracts).
 *
 *  Every fraction is kept as a monotonic max so the ring never shrinks.
 *
 *  The cycle is *armed* only once the bit has reached safe-Z for this hole: until
 *  then the motion is pre-drill positioning (the lift off the surface after a
 *  tool-change probe/touch-off, then the traverse to the hole) and reads as
 *  `traverse`. Without arming, the post-probe surface Z (z≈0) would latch
 *  descent=1 and mislabel the whole lift + traverse as a descent.
 *
 *  @param prev      previous progress for this hole (use ZERO_PHASE_PROGRESS to start).
 *  @param zMm       latest work Z (mm); positive above the surface, negative in material.
 *  @param depthMm   target plunge depth (positive magnitude: substrate + breakthrough).
 *  @param safeZMm   safe-Z retract height (positive, from the CNC profile).
 */
export function nextPhaseProgress(
  prev: PhaseProgress,
  zMm: number,
  depthMm: number,
  safeZMm: number,
): PhaseProgress {
  // Degenerate machine config — nothing meaningful to show.
  if (depthMm <= 0 || safeZMm <= 0) return prev;

  const band = Math.min(SAFE_Z_BAND_MM, safeZMm * 0.5);
  const atSafe = zMm >= safeZMm - band;

  // Arm the cycle once the bit reaches safe-Z; stays armed for the rest of the
  // hole. Before arming, the bit is still getting into position — pure traverse.
  const armed = prev.armed || atSafe;
  if (!armed) {
    return { phase: "traverse", descent: 0, drilling: 0, retract: 0, armed: false };
  }

  // Descent: how far from safe-Z toward the surface. Held at 0 within the safe-Z
  // band (parked / traversing) so a traverse never reads as descent; at/below the
  // surface it's fully done (1). Monotonic.
  const descentRaw = zMm <= 0 ? 1 : atSafe ? 0 : clamp01((safeZMm - zMm) / safeZMm);
  const descent = Math.max(prev.descent, descentRaw);

  // Drilling: fraction of target depth reached. Monotonic.
  const drilling = Math.max(prev.drilling, holeDepthFraction(zMm, depthMm));

  // Retract: only once the bottom has been reached. Before that, upward motion is
  // a peck chip-clearing move, not the final retract — keep retract held.
  let retract = prev.retract;
  if (drilling >= DRILL_DONE) {
    const retractRaw = clamp01((zMm + depthMm) / (safeZMm + depthMm));
    retract = Math.max(prev.retract, retractRaw);
  }

  // Current phase for labelling: retract wins once it has begun, else drilling
  // once the bit is in the material, else descent once it has dropped below
  // safe-Z, else traverse (still at safe-Z, moving between holes — not cutting).
  const phase: DrillHolePhase =
    retract > 0 ? "retract" : drilling > 0 ? "drilling" : descent > 0 ? "descent" : "traverse";

  return { phase, descent, drilling, retract, armed: true };
}
