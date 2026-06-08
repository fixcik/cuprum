import { describe, it, expect } from "vitest";
import {
  clampJogDelta,
  continuousJogRoom,
  JOG_EDGE_MARGIN_MM,
  type JogBoundsTuple,
} from "@/lib/jogClamp";

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

describe("continuousJogRoom", () => {
  const B: JogBoundsTuple = { x: [0, 300], y: [0, 180], z: [-45, 0] };

  it("backs the target off the edge by the pull-off margin", () => {
    // Y− from MPos 147.949 toward 0 → 147.949 room, minus the margin so the
    // target lands strictly inside the soft limit (was the error:15 regression).
    expect(continuousJogRoom([0, -1, 0], [51.4, 147.949, 0], B)).toBeCloseTo(
      147.949 - JOG_EDGE_MARGIN_MM,
      6,
    );
    // X+ toward the far edge: 300 − 51.4 − margin.
    expect(continuousJogRoom([1, 0, 0], [51.4, 147.949, 0], B)).toBeCloseTo(
      300 - 51.4 - JOG_EDGE_MARGIN_MM,
      6,
    );
  });

  it("uses the smallest per-axis room on a diagonal", () => {
    // X+ room = 300 − 290 = 10; Y+ room = 180 − 50 = 130 → min 10, less margin.
    expect(continuousJogRoom([1, 1, 0], [290, 50, 0], B)).toBeCloseTo(10 - JOG_EDGE_MARGIN_MM, 6);
  });

  it("returns 0 when within a margin of the edge (no room to move)", () => {
    expect(continuousJogRoom([0, -1, 0], [0, 0.3, 0], B)).toBe(0);
    expect(continuousJogRoom([1, 0, 0], [300, 0, 0], B)).toBe(0);
  });

  it("returns 0 when no axis is active", () => {
    expect(continuousJogRoom([0, 0, 0], [150, 90, -10], B)).toBe(0);
  });

  it("honours a custom margin", () => {
    expect(continuousJogRoom([0, 0, -1], [0, 0, -10], B, 1)).toBeCloseTo(45 - 10 - 1, 6);
  });
});
