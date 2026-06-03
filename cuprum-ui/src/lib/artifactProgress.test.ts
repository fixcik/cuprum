import { describe, it, expect } from "vitest";
import { ringFraction, overallProgress, ARTIFACT_WEIGHTS } from "@/lib/artifactProgress";

describe("ringFraction", () => {
  it("is 0 when nothing is done", () => {
    expect(ringFraction({ svg: false, preview: false, metrics: false })).toBe(0);
  });

  it("is 1 when every artifact is done", () => {
    expect(ringFraction({ svg: true, preview: true, metrics: true })).toBeCloseTo(1, 10);
  });

  it("weights metrics as the heavy step", () => {
    expect(ringFraction({ svg: false, preview: false, metrics: true })).toBe(ARTIFACT_WEIGHTS.metrics);
  });

  it("sums svg and preview weights", () => {
    expect(ringFraction({ svg: true, preview: true, metrics: false })).toBeCloseTo(
      ARTIFACT_WEIGHTS.svg + ARTIFACT_WEIGHTS.preview,
      10,
    );
  });
});

describe("overallProgress", () => {
  it("treats an empty set as fully done", () => {
    expect(overallProgress({})).toEqual({ done: 0, total: 0, fraction: 1 });
  });

  it("counts designs at fraction >= 1 as done", () => {
    expect(overallProgress({ a: 1, b: 1 })).toEqual({ done: 2, total: 2, fraction: 1 });
  });

  it("reports the mean fraction across designs", () => {
    const r = overallProgress({ a: 1, b: 0 });
    expect(r.done).toBe(1);
    expect(r.total).toBe(2);
    expect(r.fraction).toBeCloseTo(0.5, 10);
  });

  it("averages partial fractions without counting any as done", () => {
    const r = overallProgress({ a: 0.5, b: 0.7 });
    expect(r.done).toBe(0);
    expect(r.total).toBe(2);
    expect(r.fraction).toBeCloseTo(0.6, 10);
  });
});
