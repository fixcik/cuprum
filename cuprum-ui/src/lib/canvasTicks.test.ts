import { describe, it, expect } from "vitest";
import { STEP_LADDER, pickStep, gridSteps, ticksFor } from "@/lib/canvasTicks";

describe("pickStep", () => {
  it("picks the finest rung whose on-screen spacing reaches minPx", () => {
    // At 3 px/mm, an 8px minimum needs ≥2.67mm → the 5mm rung.
    expect(pickStep(3, 8)).toBe(5);
    // Zoomed in to 20 px/mm, 8px needs ≥0.4mm → the 0.5mm rung.
    expect(pickStep(20, 8)).toBe(0.5);
    // Zoomed in further (200 px/mm) → 0.05mm rung clears 8px.
    expect(pickStep(200, 8)).toBe(0.05);
  });

  it("falls back to the coarsest rung when nothing fits", () => {
    expect(pickStep(0.0001, 44)).toBe(STEP_LADDER[STEP_LADDER.length - 1]);
  });

  it("guards non-positive scale", () => {
    expect(pickStep(0, 8)).toBe(STEP_LADDER[STEP_LADDER.length - 1]);
    expect(pickStep(-5, 8)).toBe(STEP_LADDER[STEP_LADDER.length - 1]);
  });
});

describe("gridSteps", () => {
  it("labelStep is a coarser-or-equal rung than minor, labelEvery an integer ratio", () => {
    const { minor, labelStep, labelEvery } = gridSteps(3);
    expect(labelStep).toBeGreaterThanOrEqual(minor);
    expect(Number.isInteger(labelEvery)).toBe(true);
    expect(labelEvery).toBeGreaterThanOrEqual(1);
    // labelled lines coincide with grid lines.
    expect(Math.abs(labelStep - minor * labelEvery)).toBeLessThan(1e-9);
  });

  it("labels stay denser-or-equal than the grid across zoom levels", () => {
    for (const ppm of [0.5, 1, 3, 8, 20, 60, 200]) {
      const { minor, labelStep, labelEvery } = gridSteps(ppm);
      expect(labelEvery).toBe(Math.max(1, Math.round(labelStep / minor)));
    }
  });
});

describe("ticksFor", () => {
  it("emits ticks at minor multiples of the anchor across [lo, hi]", () => {
    const ticks = ticksFor(0, 0, 20, 5, 2);
    expect(ticks.map((t) => t.mm)).toEqual([0, 5, 10, 15, 20]);
    // major every 2nd → 0, 10, 20.
    expect(ticks.filter((t) => t.major).map((t) => t.mm)).toEqual([0, 10, 20]);
  });

  it("labels are values relative to the anchor", () => {
    const ticks = ticksFor(100, 100, 110, 5, 1);
    expect(ticks.map((t) => t.label)).toEqual([0, 5, 10]);
    expect(ticks.map((t) => t.mm)).toEqual([100, 105, 110]);
  });

  it("clears binary-float dust from labels", () => {
    const ticks = ticksFor(0, 0, 0.3, 0.1, 1);
    expect(ticks.map((t) => t.label)).toEqual([0, 0.1, 0.2, 0.3]);
  });

  it("returns empty for degenerate ranges and bad steps", () => {
    expect(ticksFor(0, 10, 0, 5, 1)).toEqual([]);
    expect(ticksFor(0, 0, 10, 0, 1)).toEqual([]);
    expect(ticksFor(0, NaN, 10, 5, 1)).toEqual([]);
    expect(ticksFor(0, 0, Infinity, 5, 1)).toEqual([]);
  });

  it("caps absurd ranges instead of flooding", () => {
    expect(ticksFor(0, 0, 1_000_000, 0.01, 1)).toEqual([]);
  });
});
