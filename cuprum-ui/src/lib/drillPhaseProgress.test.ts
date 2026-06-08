import { describe, it, expect } from "vitest";
import {
  nextPhaseProgress,
  ZERO_PHASE_PROGRESS,
  PHASE_COLORS,
  PHASE_WEIGHTS,
  sweepFraction,
  phaseColor,
  type PhaseProgress,
} from "@/lib/drillPhaseProgress";

// Common geometry for the tests: 2 mm depth, 5 mm safe-Z.
const DEPTH = 2;
const SAFE = 5;

/** Fold a sequence of Z samples starting from zero progress. */
function fold(zs: number[], depth = DEPTH, safe = SAFE): PhaseProgress {
  return zs.reduce(
    (acc, z) => nextPhaseProgress(acc, z, depth, safe),
    ZERO_PHASE_PROGRESS,
  );
}

describe("nextPhaseProgress — descent", () => {
  it("is 0 at safe-Z, phase=traverse (moving, not yet descending)", () => {
    const p = nextPhaseProgress(ZERO_PHASE_PROGRESS, SAFE, DEPTH, SAFE);
    expect(p.descent).toBe(0);
    expect(p.drilling).toBe(0);
    expect(p.retract).toBe(0);
    expect(p.phase).toBe("traverse");
  });

  it("stays traverse within the safe-Z band (just below safe-Z)", () => {
    // A hair under safe-Z (within the band) is still parked / traversing.
    const p = fold([SAFE, SAFE - 0.1]);
    expect(p.descent).toBe(0);
    expect(p.phase).toBe("traverse");
  });

  it("switches to descent once z drops below the safe-Z band", () => {
    const p = fold([SAFE, SAFE - 1]); // clearly below the band → real descent
    expect(p.descent).toBeGreaterThan(0);
    expect(p.phase).toBe("descent");
  });

  it("is half-way when z is half of safe-Z", () => {
    const p = fold([SAFE, SAFE / 2]); // armed at safe-Z, then half-way down
    expect(p.descent).toBeCloseTo(0.5);
    expect(p.phase).toBe("descent");
  });

  it("reaches 1 at the surface (z=0)", () => {
    const p = fold([SAFE, 0]); // armed at safe-Z, then down to the surface
    expect(p.descent).toBe(1);
  });
});

describe("nextPhaseProgress — arming (pre-drill positioning)", () => {
  it("reads the post-tool-change Z-lift as a lift (retract), not descent or traverse", () => {
    // Bit starts at the surface after a probe/touch-off (z≈0) and lifts toward
    // safe-Z. That's a Z-up move → `retract` (a lift), not `traverse` (X/Y only)
    // and not a descent. No cycle progress accrues yet (ring stays empty).
    const p = fold([0, 2]); // still below safe-Z → not armed
    expect(p.descent).toBe(0);
    expect(p.drilling).toBe(0);
    expect(p.retract).toBe(0);
    expect(p.armed).toBe(false);
    expect(p.phase).toBe("retract");
  });

  it("becomes traverse once the bit reaches safe-Z (X/Y move, armed)", () => {
    // Lift completes at safe-Z: now armed, parked at safe height for the X/Y
    // traverse to the hole → `traverse`, descent still 0.
    const p = fold([0, 2, SAFE - 0.05, SAFE]);
    expect(p.descent).toBe(0);
    expect(p.drilling).toBe(0);
    expect(p.retract).toBe(0);
    expect(p.phase).toBe("traverse");
  });

  it("then descends normally once the plunge begins from safe-Z", () => {
    // Same lift/traverse, then the actual plunge to depth.
    const p = fold([0, 2, SAFE, 0, -DEPTH]);
    expect(p.descent).toBe(1);
    expect(p.drilling).toBe(1);
    expect(p.phase).toBe("drilling");
  });
});

describe("nextPhaseProgress — drilling", () => {
  it("grows with depth, phase=drilling, descent stays full", () => {
    const p = fold([SAFE, 0, -1]); // safe → surface → half depth
    expect(p.descent).toBe(1);
    expect(p.drilling).toBeCloseTo(0.5);
    expect(p.retract).toBe(0);
    expect(p.phase).toBe("drilling");
  });

  it("reaches 1 at target depth", () => {
    const p = fold([SAFE, 0, -DEPTH]);
    expect(p.drilling).toBe(1);
  });
});

describe("nextPhaseProgress — retract", () => {
  it("reflects upward travel after reaching depth, phase=retract", () => {
    // Full plunge then retract to mid-way (z = (-depth + safe)/2 region).
    const p = fold([SAFE, -DEPTH, 1.5]);
    expect(p.drilling).toBe(1);
    // retract = (z + depth) / (safe + depth) = (1.5 + 2) / 7 = 0.5
    expect(p.retract).toBeCloseTo(0.5);
    expect(p.phase).toBe("retract");
  });

  it("reaches 1 back at safe-Z", () => {
    const p = fold([SAFE, -DEPTH, SAFE]);
    expect(p.retract).toBe(1);
  });
});

describe("nextPhaseProgress — peck drilling", () => {
  it("does not count intermediate chip-clearing retracts as the retract phase", () => {
    // Peck: plunge to -1, retract to safe, plunge to -2 (depth), retract to safe.
    const p = fold([SAFE, -1, SAFE, -DEPTH, SAFE]);
    // The mid-cycle bounce up to safe (before depth) must NOT have started retract
    // prematurely — only the FINAL retract counts, which here completes to 1.
    expect(p.drilling).toBe(1);
    expect(p.retract).toBe(1);
  });

  it("keeps retract at 0 while still pecking (depth not yet reached)", () => {
    // Two partial pecks, never reaching target depth.
    const p = fold([SAFE, -1, SAFE, -1.5, SAFE]);
    expect(p.drilling).toBeCloseTo(0.75);
    expect(p.retract).toBe(0); // never reached DRILL_DONE, so no retract
    expect(p.phase).toBe("drilling");
  });
});

describe("nextPhaseProgress — monotonicity", () => {
  it("never shrinks drilling when the bit bounces up", () => {
    const deep = fold([SAFE, 0, -DEPTH]);
    const bounced = nextPhaseProgress(deep, -0.5, DEPTH, SAFE);
    expect(bounced.drilling).toBe(1); // held, not reduced to 0.25
  });

  it("never shrinks descent once at the surface", () => {
    const atSurface = fold([SAFE, 0]);
    // An impossible upward blip shouldn't reduce descent.
    const blip = nextPhaseProgress(atSurface, 1, DEPTH, SAFE);
    expect(blip.descent).toBe(1);
  });
});

describe("nextPhaseProgress — degenerate config", () => {
  it("returns prev unchanged for non-positive depth", () => {
    const p = nextPhaseProgress(ZERO_PHASE_PROGRESS, -1, 0, SAFE);
    expect(p).toBe(ZERO_PHASE_PROGRESS);
  });

  it("returns prev unchanged for non-positive safe-Z", () => {
    const p = nextPhaseProgress(ZERO_PHASE_PROGRESS, -1, DEPTH, 0);
    expect(p).toBe(ZERO_PHASE_PROGRESS);
  });
});

describe("sweepFraction", () => {
  it("is 0 for an untouched hole", () => {
    expect(sweepFraction(ZERO_PHASE_PROGRESS)).toBe(0);
  });

  it("is 1 when all three phases are complete", () => {
    expect(
      sweepFraction({ phase: "retract", descent: 1, drilling: 1, retract: 1 }),
    ).toBeCloseTo(1, 6);
  });

  it("weights the phases 28/50/22", () => {
    expect(PHASE_WEIGHTS.descent + PHASE_WEIGHTS.drilling + PHASE_WEIGHTS.retract).toBeCloseTo(1, 6);
    expect(
      sweepFraction({ phase: "drilling", descent: 1, drilling: 0.5, retract: 0 }),
    ).toBeCloseTo(0.28 + 0.5 * 0.5, 6);
  });

  it("clamps to [0,1]", () => {
    expect(
      sweepFraction({ phase: "descent", descent: -2, drilling: 0, retract: 0 }),
    ).toBe(0);
  });
});

describe("phaseColor", () => {
  it("uses the bit colour for the drilling phase", () => {
    expect(phaseColor("drilling", "#e8893a", false)).toBe("#e8893a");
  });

  it("uses handoff cyan/green for descent/retract", () => {
    expect(phaseColor("descent", "#e8893a", false)).toBe(PHASE_COLORS.descent);
    expect(phaseColor("retract", "#e8893a", false)).toBe(PHASE_COLORS.retract);
    expect(PHASE_COLORS.descent).toBe("#46e0ff");
    expect(PHASE_COLORS.retract).toBe("#3fbf6f");
  });

  it("uses muted slate for the traverse phase", () => {
    expect(phaseColor("traverse", "#e8893a", false)).toBe(PHASE_COLORS.traverse);
    expect(PHASE_COLORS.traverse).toBe("#9aa3af");
  });

  it("returns idle grey regardless of phase when idle", () => {
    expect(phaseColor("drilling", "#e8893a", true)).toBe("#8a929e");
  });
});
