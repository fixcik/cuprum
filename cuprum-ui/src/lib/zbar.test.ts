import { describe, expect, it } from "vitest";
import { machineZFromFraction, parseZTarget } from "./zbar";

describe("machineZFromFraction", () => {
  it("maps the bottom of the bar to -envZ and the top to 0", () => {
    expect(machineZFromFraction(0, 80)).toBe(-80);
    expect(machineZFromFraction(1, 80)).toBe(0);
  });

  it("maps the middle to half the envelope", () => {
    expect(machineZFromFraction(0.5, 80)).toBe(-40);
    expect(machineZFromFraction(0.25, 80)).toBe(-60);
  });

  it("clamps fractions outside [0, 1] to the envelope ends", () => {
    expect(machineZFromFraction(-0.3, 80)).toBe(-80);
    expect(machineZFromFraction(1.4, 80)).toBe(0);
  });

  it("treats the envelope depth as a magnitude (sign-agnostic)", () => {
    expect(machineZFromFraction(0, -80)).toBe(-80);
    expect(machineZFromFraction(0.5, -80)).toBe(-40);
  });
});

describe("parseZTarget", () => {
  it("accepts a finite value inside the travel [−envZ, 0]", () => {
    expect(parseZTarget("-21.4", 80)).toBeCloseTo(-21.4);
    expect(parseZTarget("0", 80)).toBe(0);
    expect(parseZTarget("-80", 80)).toBe(-80);
  });

  it("accepts a decimal comma", () => {
    expect(parseZTarget("-21,4", 80)).toBeCloseTo(-21.4);
  });

  it("trims surrounding whitespace", () => {
    expect(parseZTarget("  -5.5  ", 80)).toBeCloseTo(-5.5);
  });

  it("rejects values outside the travel (not clamped)", () => {
    expect(parseZTarget("-80.1", 80)).toBeNull(); // below the floor
    expect(parseZTarget("0.1", 80)).toBeNull(); // above the ceiling
  });

  it("rejects non-numeric / empty input", () => {
    expect(parseZTarget("", 80)).toBeNull();
    expect(parseZTarget("abc", 80)).toBeNull();
    expect(parseZTarget("--3", 80)).toBeNull();
    expect(parseZTarget("NaN", 80)).toBeNull();
  });

  it("treats the envelope as a magnitude (sign-agnostic)", () => {
    expect(parseZTarget("-40", -80)).toBe(-40);
    expect(parseZTarget("-80.1", -80)).toBeNull();
  });
});
