import { describe, expect, it } from "vitest";
import { drillControlsEnabled } from "@/lib/drillControls";
import type { DrillRunPhase } from "@/lib/drillRunState";

describe("drillControlsEnabled", () => {
  it("running → both pause and stop enabled (bit is moving)", () => {
    expect(drillControlsEnabled("running")).toEqual({ pause: true, stop: true });
  });

  it("paused → both enabled (pause button is 'Продолжить', stop still ends the run)", () => {
    expect(drillControlsEnabled("paused")).toEqual({ pause: true, stop: true });
  });

  it("awaitingToolChange → stop only (machine idle, but the run can still be aborted)", () => {
    expect(drillControlsEnabled("awaitingToolChange")).toEqual({ pause: false, stop: true });
  });

  it("idle → neither (nothing to pause or stop before the run starts)", () => {
    expect(drillControlsEnabled("idle")).toEqual({ pause: false, stop: false });
  });

  it("pausing → neither (transient; the pause is already settling)", () => {
    expect(drillControlsEnabled("pausing")).toEqual({ pause: false, stop: false });
  });

  it("stopping → neither (the footer shows a banner + cancel instead)", () => {
    expect(drillControlsEnabled("stopping")).toEqual({ pause: false, stop: false });
  });

  it("done → neither", () => {
    expect(drillControlsEnabled("done")).toEqual({ pause: false, stop: false });
  });

  it("error → neither", () => {
    expect(drillControlsEnabled("error")).toEqual({ pause: false, stop: false });
  });

  it("covers every phase without throwing (exhaustive)", () => {
    const phases: DrillRunPhase[] = [
      "idle",
      "running",
      "pausing",
      "paused",
      "stopping",
      "awaitingToolChange",
      "done",
      "error",
    ];
    for (const p of phases) {
      const r = drillControlsEnabled(p);
      expect(typeof r.pause).toBe("boolean");
      expect(typeof r.stop).toBe("boolean");
    }
  });
});
