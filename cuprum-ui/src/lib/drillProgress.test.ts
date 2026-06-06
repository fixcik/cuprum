import { describe, it, expect } from "vitest";
import { holeDepthFraction } from "@/lib/drillProgress";

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
