import { describe, expect, it } from "vitest";
import { scaledMotionSec } from "@/lib/feedOverride";

describe("scaledMotionSec", () => {
  // 10s total, 6s feed-limited, 4s rapid.
  it("100% override → unchanged", () => {
    expect(scaledMotionSec(10, 6, 100)).toBeCloseTo(10);
  });

  it("50% override → feed part doubles, rapid stays (4 + 6/0.5 = 16)", () => {
    expect(scaledMotionSec(10, 6, 50)).toBeCloseTo(16);
  });

  it("200% override → feed part halves, rapid stays (4 + 6/2 = 7)", () => {
    expect(scaledMotionSec(10, 6, 200)).toBeCloseTo(7);
  });

  it("no feed share → override has no effect", () => {
    expect(scaledMotionSec(10, 0, 50)).toBeCloseTo(10);
  });

  it("all feed → scales fully (10/0.5 = 20)", () => {
    expect(scaledMotionSec(10, 10, 50)).toBeCloseTo(20);
  });

  it("clamps feed share to motion (feed > motion treated as all-feed)", () => {
    expect(scaledMotionSec(10, 99, 50)).toBeCloseTo(20);
  });

  it("0 or negative override → no scaling (divide-by-zero guard)", () => {
    expect(scaledMotionSec(10, 6, 0)).toBeCloseTo(10);
    expect(scaledMotionSec(10, 6, -5)).toBeCloseTo(10);
  });

  it("zero motion → zero", () => {
    expect(scaledMotionSec(0, 0, 50)).toBe(0);
  });
});
