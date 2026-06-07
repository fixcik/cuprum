import { describe, expect, it } from "vitest";
import { machineZFromFraction } from "./zbar";

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
