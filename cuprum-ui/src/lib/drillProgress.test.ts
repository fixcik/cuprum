import { describe, it, expect } from "vitest";
import { holeDepthFraction, nextMaxFraction } from "@/lib/drillProgress";

describe("holeDepthFraction", () => {
  it("returns 0 for positive z (safe Z / retracted)", () => {
    expect(holeDepthFraction(5, 2)).toBe(0);
  });

  it("returns 0 for z = 0 (at surface)", () => {
    expect(holeDepthFraction(0, 2)).toBe(0);
  });

  it("returns 1 when z equals -targetDepth (fully plunged)", () => {
    expect(holeDepthFraction(-2, 2)).toBe(1);
  });

  it("clamps to 1 when z exceeds target depth", () => {
    expect(holeDepthFraction(-10, 2)).toBe(1);
  });

  it("returns 0.5 at half depth (z=-1, target=2)", () => {
    expect(holeDepthFraction(-1, 2)).toBe(0.5);
  });

  it("returns 0 when targetDepthMm is zero", () => {
    expect(holeDepthFraction(-1, 0)).toBe(0);
  });

  it("returns 0 when targetDepthMm is negative", () => {
    expect(holeDepthFraction(-1, -3)).toBe(0);
  });
});

describe("nextMaxFraction", () => {
  it("grows when a deeper z arrives", () => {
    const f1 = nextMaxFraction(0, -1, 2);   // 0.5
    const f2 = nextMaxFraction(f1, -2, 2);  // 1.0
    expect(f1).toBe(0.5);
    expect(f2).toBe(1);
  });

  it("holds prevMax when z retracts to positive (retract after plunge)", () => {
    const afterPlunge = nextMaxFraction(0, -2, 2);    // 1.0
    const afterRetract = nextMaxFraction(afterPlunge, 5, 2); // retracted, still 1.0
    expect(afterRetract).toBe(1);
  });

  it("grows through peck passes and holds on retract", () => {
    // shallow peck
    let max = nextMaxFraction(0, -0.5, 2); // 0.25
    expect(max).toBeCloseTo(0.25);

    // retract between pecks
    max = nextMaxFraction(max, 5, 2); // still 0.25
    expect(max).toBeCloseTo(0.25);

    // deeper peck
    max = nextMaxFraction(max, -1.5, 2); // 0.75
    expect(max).toBeCloseTo(0.75);

    // retract again
    max = nextMaxFraction(max, 5, 2); // still 0.75
    expect(max).toBeCloseTo(0.75);
  });
});
