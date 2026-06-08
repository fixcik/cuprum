import { describe, expect, it } from "vitest";
import en from "@/locales/en/grbl.json";
import ru from "@/locales/ru/grbl.json";
import {
  GRBL_SETTINGS,
  criticalAmong,
  decodeMask,
  diffDrafts,
  encodeMask,
  normalizeValue,
  validate,
  type GrblSettingDef,
} from "@/lib/grblSettings";

const XYZ = [
  { bit: 0, labelKey: "x" },
  { bit: 1, labelKey: "y" },
  { bit: 2, labelKey: "z" },
];

describe("catalog integrity", () => {
  it("has no duplicate setting numbers", () => {
    const ns = GRBL_SETTINGS.map((d) => d.n);
    expect(new Set(ns).size).toBe(ns.length);
  });

  it("every setting has label+desc in both locales", () => {
    for (const d of GRBL_SETTINGS) {
      expect((en.setting as Record<string, unknown>)[d.key], `en ${d.key}`).toBeDefined();
      expect((ru.setting as Record<string, unknown>)[d.key], `ru ${d.key}`).toBeDefined();
    }
  });

  it("mask settings have non-empty bits; numeric settings have a unit", () => {
    for (const d of GRBL_SETTINGS) {
      if (d.type === "mask") expect(d.bits && d.bits.length > 0, `bits ${d.n}`).toBe(true);
      if (d.type === "int" || d.type === "float") expect(d.unit, `unit ${d.n}`).toBeTruthy();
    }
  });
});

describe("decodeMask / encodeMask", () => {
  it("round-trips", () => {
    expect(decodeMask(5, XYZ)).toEqual([true, false, true]);
    expect(encodeMask([true, false, true], XYZ)).toBe(5);
    expect(encodeMask(decodeMask(7, XYZ), XYZ)).toBe(7);
    expect(encodeMask([false, false, false], XYZ)).toBe(0);
  });
});

describe("normalizeValue", () => {
  it("compares numbers by value", () => {
    expect(normalizeValue("1")).toBe(normalizeValue("1.000"));
    expect(normalizeValue("299")).toBe(normalizeValue("299.0"));
    expect(normalizeValue("abc")).toBe("abc");
  });
});

describe("validate", () => {
  const bool: GrblSettingDef = { n: 20, key: "x", group: "limits", type: "bool" };
  const flt: GrblSettingDef = { n: 110, key: "x", group: "axis", type: "float", unit: "mmPerMin" };
  const int: GrblSettingDef = { n: 0, key: "x", group: "general", type: "int", unit: "us" };
  it("checks bool / number / range", () => {
    expect(validate(bool, "1").ok).toBe(true);
    expect(validate(bool, "2").ok).toBe(false);
    expect(validate(flt, "2000.5").ok).toBe(true);
    expect(validate(flt, "-5").ok).toBe(false);
    expect(validate(flt, "").ok).toBe(false);
    expect(validate(int, "10.5").ok).toBe(false);
  });
});

describe("diffDrafts / criticalAmong", () => {
  it("detects only real changes (normalised)", () => {
    const baseline = { 20: "1", 110: "2000.000" };
    expect(diffDrafts(baseline, { 110: "2000" })).toEqual([]);
    expect(diffDrafts(baseline, { 20: "0", 110: "1500" })).toEqual([20, 110]);
  });
  it("flags critical changes", () => {
    expect(criticalAmong([20, 130]).map((d) => d.n)).toEqual([130]);
    expect(criticalAmong([20]).length).toBe(0);
  });
});
