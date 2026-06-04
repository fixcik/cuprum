import { describe, it, expect } from "vitest";
import { copperMicrons, stackupTotalMm } from "@/lib/stackup";

describe("copperMicrons", () => {
  it("maps standard copper weights to microns", () => {
    expect(copperMicrons(0.5)).toBe(17.5);
    expect(copperMicrons(1)).toBe(35);
    expect(copperMicrons(2)).toBe(70);
  });
  it("falls back to 35µm/oz for unknown weights", () => {
    expect(copperMicrons(3)).toBe(105);
  });
});

describe("stackupTotalMm", () => {
  it("adds copper on both sides when double-sided", () => {
    expect(stackupTotalMm(1.0, 1, true)).toBeCloseTo(1.07, 3);
  });
  it("adds copper on one side when single-sided", () => {
    expect(stackupTotalMm(1.6, 1, false)).toBeCloseTo(1.635, 3);
  });
});
