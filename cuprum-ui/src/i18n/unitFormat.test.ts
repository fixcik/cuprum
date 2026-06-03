import { describe, it, expect } from "vitest";
import {
  lenUnit,
  fmtLen,
  fmtLenPair,
  toDisplay,
  fromDisplay,
  unitLabel,
  MIL_PER_MM,
  type LenUnit,
} from "@/i18n/unitFormat";

// Identity label so assertions show the chosen unit by name.
const label = (u: LenUnit) => u;

describe("lenUnit", () => {
  it("metric: µm below 0.1 mm, mm otherwise", () => {
    expect(lenUnit(0.05, "mm")).toBe("um");
    expect(lenUnit(0, "mm")).toBe("mm");
    expect(lenUnit(0.1, "mm")).toBe("mm");
    expect(lenUnit(2, "mm")).toBe("mm");
  });
  it("imperial: inch at or above 1 inch, mil below", () => {
    expect(lenUnit(25.4, "imperial")).toBe("inch");
    expect(lenUnit(0.15, "imperial")).toBe("mil");
  });
});

describe("fmtLen", () => {
  it("formats metric mm and µm", () => {
    expect(fmtLen(1.5, "mm", label)).toBe("1.5 mm");
    expect(fmtLen(0.05, "mm", label)).toBe("50 um");
  });
  it("formats imperial inch and mil", () => {
    expect(fmtLen(25.4, "imperial", label)).toBe("1 inch");
    expect(fmtLen(0.15, "imperial", label)).toBe("5.9 mil");
  });
});

describe("fmtLenPair", () => {
  it("renders all values in the finest shared unit (metric)", () => {
    expect(fmtLenPair([0.05, 1.5], "mm", label)).toEqual(["50 um", "1500 um"]);
  });
  it("renders all values in the finest shared unit (imperial)", () => {
    expect(fmtLenPair([0.15, 30], "imperial", label)).toEqual([
      `${+(0.15 * MIL_PER_MM).toFixed(1)} mil`,
      `${+(30 * MIL_PER_MM).toFixed(1)} mil`,
    ]);
  });
});

describe("toDisplay / fromDisplay", () => {
  it("passes through unchanged in metric", () => {
    expect(toDisplay(5, "fine", "mm")).toBe(5);
    expect(fromDisplay(5, "coarse", "mm")).toBe(5);
  });
  it("converts fine to mil and coarse to inch in imperial", () => {
    expect(toDisplay(0.15, "fine", "imperial")).toBeCloseTo(0.15 * MIL_PER_MM, 10);
    expect(toDisplay(25.4, "coarse", "imperial")).toBeCloseTo(1, 10);
  });
  it("round-trips mm to display and back", () => {
    for (const [mm, dim] of [[0.2, "fine"], [50, "coarse"]] as const) {
      expect(fromDisplay(toDisplay(mm, dim, "imperial"), dim, "imperial")).toBeCloseTo(mm, 10);
    }
  });
});

describe("unitLabel", () => {
  it("is mm in metric and inch/mil per dimension in imperial", () => {
    expect(unitLabel("fine", "mm", label)).toBe("mm");
    expect(unitLabel("coarse", "mm", label)).toBe("mm");
    expect(unitLabel("fine", "imperial", label)).toBe("mil");
    expect(unitLabel("coarse", "imperial", label)).toBe("inch");
  });
});
