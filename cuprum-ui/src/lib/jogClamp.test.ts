import { describe, it, expect } from "vitest";
import { clampJogDelta } from "@/lib/jogClamp";

describe("clampJogDelta", () => {
  it("passes a move that stays inside the range unchanged", () => {
    expect(clampJogDelta(5, 100, 0, 300)).toBe(5);
    expect(clampJogDelta(-5, 100, 0, 300)).toBe(-5);
  });

  it("clamps a move that would cross the upper bound", () => {
    // pos 298 + 5 = 303 → clamp to 300 → delta 2
    expect(clampJogDelta(5, 298, 0, 300)).toBe(2);
  });

  it("clamps a move that would cross the lower bound", () => {
    // pos 2 + (-5) = -3 → clamp to 0 → delta -2
    expect(clampJogDelta(-5, 2, 0, 300)).toBe(-2);
  });

  it("returns 0 when already parked at the edge", () => {
    expect(clampJogDelta(5, 300, 0, 300)).toBe(0);
    expect(clampJogDelta(-5, 0, 0, 300)).toBe(0);
  });

  it("handles a negative-floor Z range (ceiling 0, floor -travel)", () => {
    // at MPos Z -1, jog +0.5 toward the ceiling stays inside → 0.5
    expect(clampJogDelta(0.5, -1, -45, 0)).toBe(0.5);
    // at MPos Z -0.2, jog +0.5 would pass 0 → clamp to 0.2
    expect(clampJogDelta(0.5, -0.2, -45, 0)).toBeCloseTo(0.2, 6);
  });
});
