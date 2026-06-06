import { describe, it, expect } from "vitest";
import {
  nextPhaseProgress,
  ZERO_PHASE_PROGRESS,
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
  it("is 0 at safe-Z, phase=descent", () => {
    const p = nextPhaseProgress(ZERO_PHASE_PROGRESS, SAFE, DEPTH, SAFE);
    expect(p.descent).toBe(0);
    expect(p.drilling).toBe(0);
    expect(p.retract).toBe(0);
    expect(p.phase).toBe("descent");
  });

  it("is half-way when z is half of safe-Z", () => {
    const p = nextPhaseProgress(ZERO_PHASE_PROGRESS, SAFE / 2, DEPTH, SAFE);
    expect(p.descent).toBeCloseTo(0.5);
    expect(p.phase).toBe("descent");
  });

  it("reaches 1 at the surface (z=0)", () => {
    const p = nextPhaseProgress(ZERO_PHASE_PROGRESS, 0, DEPTH, SAFE);
    expect(p.descent).toBe(1);
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
