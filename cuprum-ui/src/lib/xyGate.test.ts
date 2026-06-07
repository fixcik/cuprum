import { describe, expect, it } from "vitest";
import { checkXYGate, planWorkExtent, type WorkExtent } from "./xyGate";
import type { PanelDrillPlan } from "@/lib/panelDrill";

/** Minimal plan helper: one group of holes at the given panel-space points. */
function planOf(holes: [number, number][]): PanelDrillPlan {
  return {
    groups: [
      {
        diameterMm: 1,
        class: "pth",
        toolId: "t1",
        holes: holes.map(([xMm, yMm]) => ({ xMm, yMm })),
      },
    ],
    totalHoles: holes.length,
    unmatchedDiametersMm: [],
    skippedInKeepout: 0,
    registrationInKeepout: 0,
  };
}

describe("planWorkExtent", () => {
  it("returns null for an empty plan", () => {
    expect(planWorkExtent(planOf([]), "bottom-left", 100, 80)).toBeNull();
  });

  it("maps bottom-left datum (Y flips around panel height)", () => {
    // panel 100×80; holes at (10,20) and (40,60).
    // bottom-left → (x, H − y): (10,60) and (40,20).
    const e = planWorkExtent(planOf([[10, 20], [40, 60]]), "bottom-left", 100, 80);
    expect(e).toEqual<WorkExtent>({ minX: 10, maxX: 40, minY: 20, maxY: 60 });
  });

  it("maps bottom-right datum (X goes negative as x − W)", () => {
    // bottom-right → (x − W, H − y): (10−100, 80−20)=(−90,60), (40−100,80−60)=(−60,20).
    const e = planWorkExtent(planOf([[10, 20], [40, 60]]), "bottom-right", 100, 80);
    expect(e).toEqual<WorkExtent>({ minX: -90, maxX: -60, minY: 20, maxY: 60 });
  });
});

describe("checkXYGate", () => {
  const extent: WorkExtent = { minX: 0, maxX: 40, minY: 0, maxY: 60 };

  it("returns not-zeroed when work zero XY is null", () => {
    expect(checkXYGate(null, extent, 300, 180)).toEqual({ valid: false, reason: "not-zeroed" });
  });

  it("is valid when there are no holes (null extent)", () => {
    expect(checkXYGate({ x: 0, y: 0 }, null, 300, 180)).toEqual({ valid: true });
  });

  it("is valid when the whole bbox fits inside the envelope", () => {
    // zero at (10,10): bbox machine X 10..50 ⊆ 0..300, Y 10..70 ⊆ 0..180.
    expect(checkXYGate({ x: 10, y: 10 }, extent, 300, 180)).toEqual({ valid: true });
  });

  it("flags an overshoot past the max-travel end", () => {
    // zero at (280,10): bbox X 280..320 > 300 by 20.
    const r = checkXYGate({ x: 280, y: 10 }, extent, 300, 180);
    expect(r).toEqual({
      valid: false,
      reason: "out-of-bounds",
      violations: [{ axis: "x", side: "max", overshootMm: 20 }],
    });
  });

  it("flags an overshoot below the 0 end", () => {
    // zero at (−5, 10): bbox X −5..35, min −5 < 0 by 5.
    const r = checkXYGate({ x: -5, y: 10 }, extent, 300, 180);
    expect(r).toEqual({
      valid: false,
      reason: "out-of-bounds",
      violations: [{ axis: "x", side: "min", overshootMm: 5 }],
    });
  });

  it("reports violations on both axes at once", () => {
    // zero at (−5, 130): X min −5<0 by 5; Y max 130+60=190 > 180 by 10.
    const r = checkXYGate({ x: -5, y: 130 }, extent, 300, 180);
    expect(r).toEqual({
      valid: false,
      reason: "out-of-bounds",
      violations: [
        { axis: "x", side: "min", overshootMm: 5 },
        { axis: "y", side: "max", overshootMm: 10 },
      ],
    });
  });

  it("is valid at the exact boundary (within epsilon)", () => {
    // zero at (260,120): X 260..300 (==300 ok), Y 120..180 (==180 ok).
    expect(checkXYGate({ x: 260, y: 120 }, extent, 300, 180)).toEqual({ valid: true });
  });
});
