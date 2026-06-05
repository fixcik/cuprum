import { describe, it, expect } from "vitest";
import { workPosToPanel, shouldShowMarker } from "./machineMarker";

describe("workPosToPanel", () => {
  it("flips Y about panel height (work zero = bottom-left)", () => {
    expect(workPosToPanel(0, 0, 60)).toEqual({ xMm: 0, yMm: 60 });
    expect(workPosToPanel(0, 60, 60)).toEqual({ xMm: 0, yMm: 0 });
    expect(workPosToPanel(25, 10, 60)).toEqual({ xMm: 25, yMm: 50 });
  });
  it("passes X through unchanged", () => {
    expect(workPosToPanel(42.5, 5, 60).xMm).toBeCloseTo(42.5);
  });
  it("inverts machinePoint for non-default datums (W=40, H=60)", () => {
    // machinePoint(x,y,datum,40,60) then workPosToPanel must round-trip to (x,y).
    // top-left: machine = (x, -y) → back = (mx, -my)
    expect(workPosToPanel(25, -10, 60, "top-left", 40)).toEqual({ xMm: 25, yMm: 10 });
    // bottom-right: machine = (x-40, 60-y) → back = (mx+40, 60-my)
    expect(workPosToPanel(-15, 50, 60, "bottom-right", 40)).toEqual({ xMm: 25, yMm: 10 });
    // top-right: machine = (x-40, -y) → back = (mx+40, -my)
    expect(workPosToPanel(-15, -10, 60, "top-right", 40)).toEqual({ xMm: 25, yMm: 10 });
  });
});

describe("shouldShowMarker", () => {
  it("shows only during an active run with a fresh position", () => {
    expect(shouldShowMarker("running", true)).toBe(true);
    expect(shouldShowMarker("paused", true)).toBe(true);
    expect(shouldShowMarker("awaitingToolChange", true)).toBe(true);
  });
  it("hides when idle/done/error even with a fresh position", () => {
    expect(shouldShowMarker("idle", true)).toBe(false);
    expect(shouldShowMarker("done", true)).toBe(false);
    expect(shouldShowMarker("error", true)).toBe(false);
  });
  it("hides during a run when the position is stale/absent", () => {
    expect(shouldShowMarker("running", false)).toBe(false);
  });
});
