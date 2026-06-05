import { describe, it, expect } from "vitest";
import {
  newPanelDoc,
  DEFAULT_STACKUP,
  BUILTIN_PANEL_PRESETS,
  COPPER_WEIGHTS,
} from "@/lib/panel";

describe("newPanelDoc", () => {
  it("builds a fresh panel at origin with the given dimensions and no contents", () => {
    const doc = newPanelDoc(120, 80);
    expect(doc).toEqual({
      schema_version: 3,
      width_mm: 120,
      height_mm: 80,
      origin_x_mm: 0,
      origin_y_mm: 0,
      instances: [],
      tooling_holes: [],
      keep_out_zones: [],
      drill_class_overrides: {},
    });
  });

  it("returns independent instance/tooling arrays per call", () => {
    const a = newPanelDoc(10, 10);
    const b = newPanelDoc(10, 10);
    expect(a.instances).not.toBe(b.instances);
    expect(a.tooling_holes).not.toBe(b.tooling_holes);
  });
});

describe("DEFAULT_STACKUP", () => {
  it("is 1 oz copper on 1.6 mm FR4, double-sided", () => {
    expect(DEFAULT_STACKUP).toEqual({
      copper_weight_oz: 1,
      substrate_thickness_mm: 1.6,
      double_sided: true,
    });
  });

  it("uses a copper weight that is offered in the selectable list", () => {
    expect(COPPER_WEIGHTS).toContain(DEFAULT_STACKUP.copper_weight_oz);
  });
});

describe("BUILTIN_PANEL_PRESETS", () => {
  it("has unique ids", () => {
    const ids = BUILTIN_PANEL_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has positive dimensions and a valid stackup for every preset", () => {
    for (const p of BUILTIN_PANEL_PRESETS) {
      expect(p.widthMm).toBeGreaterThan(0);
      expect(p.heightMm).toBeGreaterThan(0);
      expect(p.stackup.substrate_thickness_mm).toBeGreaterThan(0);
      expect(COPPER_WEIGHTS).toContain(p.stackup.copper_weight_oz);
    }
  });
});
