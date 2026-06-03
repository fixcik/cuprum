import { describe, it, expect } from "vitest";
import { minAbove } from "@/lib/feasibility";

describe("minAbove", () => {
  it("returns the smallest width at or above the floor", () => {
    expect(minAbove([0.01, 0.1, 0.2], 0.05)).toBe(0.1);
  });

  it("drops sub-floor artefact apertures and returns null when none qualify", () => {
    expect(minAbove([0.01, 0.02], 0.05)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(minAbove([], 0.05)).toBeNull();
  });
});
