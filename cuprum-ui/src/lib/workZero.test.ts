import { describe, expect, it } from "vitest";
import {
  workZeroFromStatus,
  parseHomingEnabled,
  parseSoftLimitsEnabled,
  parseMaxTravel,
  parseMaxSpindle,
  restoreZeroGcode,
} from "@/lib/workZero";

describe("workZeroFromStatus", () => {
  it("returns machine origin when wpos is all zeros", () => {
    const result = workZeroFromStatus([10, 20, 0], [0, 0, 0]);
    expect(result).toEqual({ x: 10, y: 20 });
  });

  it("subtracts wpos from mpos to get the work origin in machine coords", () => {
    const result = workZeroFromStatus([15.5, -30.0, -5.0], [5.5, -10.0, 0]);
    expect(result.x).toBeCloseTo(10.0);
    expect(result.y).toBeCloseTo(-20.0);
  });

  it("handles zero mpos and non-zero wpos", () => {
    const result = workZeroFromStatus([0, 0, 0], [5, 10, 0]);
    expect(result).toEqual({ x: -5, y: -10 });
  });
});

describe("parseHomingEnabled", () => {
  it("returns true for $22=1", () => {
    expect(parseHomingEnabled("$22=1")).toBe(true);
  });

  it("returns false for $22=0", () => {
    expect(parseHomingEnabled("$22=0")).toBe(false);
  });

  it("returns null for a different setting line ($20=1)", () => {
    expect(parseHomingEnabled("$20=1")).toBeNull();
  });

  it("returns null for junk input", () => {
    expect(parseHomingEnabled("ok")).toBeNull();
    expect(parseHomingEnabled("")).toBeNull();
    expect(parseHomingEnabled("error:1")).toBeNull();
  });

  it("handles leading whitespace", () => {
    expect(parseHomingEnabled("  $22=1")).toBe(true);
    expect(parseHomingEnabled("  $22=0")).toBe(false);
  });

  it("returns true for non-zero values other than 1", () => {
    expect(parseHomingEnabled("$22=2")).toBe(true);
  });
});

describe("parseSoftLimitsEnabled", () => {
  it("returns true for $20=1", () => {
    expect(parseSoftLimitsEnabled("$20=1")).toBe(true);
  });

  it("returns false for $20=0", () => {
    expect(parseSoftLimitsEnabled("$20=0")).toBe(false);
  });

  it("returns null for a different setting line ($22=1)", () => {
    expect(parseSoftLimitsEnabled("$22=1")).toBeNull();
  });

  it("returns null for junk input", () => {
    expect(parseSoftLimitsEnabled("ok")).toBeNull();
    expect(parseSoftLimitsEnabled("")).toBeNull();
  });

  it("handles leading whitespace", () => {
    expect(parseSoftLimitsEnabled("  $20=1")).toBe(true);
  });
});

describe("parseMaxTravel", () => {
  it("parses $130 as the X axis", () => {
    expect(parseMaxTravel("$130=300.000")).toEqual({ axis: 0, value: 300 });
  });

  it("parses $131 as the Y axis", () => {
    expect(parseMaxTravel("$131=180.5")).toEqual({ axis: 1, value: 180.5 });
  });

  it("parses $132 as the Z axis", () => {
    expect(parseMaxTravel("$132=45")).toEqual({ axis: 2, value: 45 });
  });

  it("returns null for non-travel settings", () => {
    expect(parseMaxTravel("$20=1")).toBeNull();
    expect(parseMaxTravel("$133=10")).toBeNull();
    expect(parseMaxTravel("ok")).toBeNull();
  });

  it("handles leading whitespace", () => {
    expect(parseMaxTravel("  $130=300.000")).toEqual({ axis: 0, value: 300 });
  });
});

describe("parseMaxSpindle", () => {
  it("parses $30 as the max spindle speed", () => {
    expect(parseMaxSpindle("$30=1000")).toBe(1000);
  });

  it("parses a fractional value", () => {
    expect(parseMaxSpindle("$30=12000.0")).toBe(12000);
  });

  it("returns null for non-spindle settings", () => {
    expect(parseMaxSpindle("$31=0")).toBeNull();
    expect(parseMaxSpindle("$130=300")).toBeNull();
    expect(parseMaxSpindle("ok")).toBeNull();
  });

  it("handles leading whitespace", () => {
    expect(parseMaxSpindle("  $30=1000")).toBe(1000);
  });
});

describe("restoreZeroGcode", () => {
  it("formats G10 L2 P1 with 3 decimal places", () => {
    expect(restoreZeroGcode({ x: 10, y: -20 })).toBe("G10 L2 P1 X10.000 Y-20.000");
  });

  it("handles zero values", () => {
    expect(restoreZeroGcode({ x: 0, y: 0 })).toBe("G10 L2 P1 X0.000 Y0.000");
  });

  it("handles fractional values", () => {
    expect(restoreZeroGcode({ x: -123.456, y: 78.9 })).toBe("G10 L2 P1 X-123.456 Y78.900");
  });
});
