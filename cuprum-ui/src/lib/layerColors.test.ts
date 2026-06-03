import { describe, it, expect } from "vitest";
import {
  stackOrder,
  missingRequired,
  colorFor,
  sideOf,
  DEFAULT_LAYER_COLORS,
  LAYER_STACK_ORDER,
  LAYER_ORDER,
  LAYER_Z,
} from "@/lib/layerColors";
import type { LayerType } from "@/lib/api";

describe("stackOrder", () => {
  it("orders from the bare board outward (edgeCuts first, drill next)", () => {
    expect(stackOrder("edgeCuts")).toBe(0);
    expect(stackOrder("drill")).toBe(1);
    expect(stackOrder("topSilk")).toBe(LAYER_STACK_ORDER.indexOf("topSilk"));
    expect(stackOrder("topSilk")).toBeGreaterThan(stackOrder("topCopper"));
  });

  it("sorts an unknown layer type last", () => {
    expect(stackOrder("bogus" as LayerType)).toBe(LAYER_STACK_ORDER.length);
  });
});

describe("missingRequired", () => {
  it("reports edgeCuts missing when absent", () => {
    expect(missingRequired([])).toEqual(["edgeCuts"]);
    expect(missingRequired(["topCopper"])).toEqual(["edgeCuts"]);
  });

  it("reports nothing missing once edgeCuts is present", () => {
    expect(missingRequired(["edgeCuts", "topCopper"])).toEqual([]);
  });
});

describe("colorFor", () => {
  it("falls back to the default palette", () => {
    expect(colorFor("topCopper")).toBe(DEFAULT_LAYER_COLORS.topCopper);
  });

  it("lets a manifest override win for the matching type", () => {
    expect(colorFor("topCopper", { topCopper: "#ffffff" })).toBe("#ffffff");
  });

  it("ignores an override for a different type", () => {
    expect(colorFor("topCopper", { bottomCopper: "#ffffff" })).toBe(DEFAULT_LAYER_COLORS.topCopper);
  });
});

describe("sideOf", () => {
  it("maps top* to top and bottom* to bottom", () => {
    expect(sideOf("topCopper")).toBe("top");
    expect(sideOf("bottomSilk")).toBe("bottom");
  });

  it("maps through-features and unsided layers to both", () => {
    expect(sideOf("edgeCuts")).toBe("both");
    expect(sideOf("drill")).toBe("both");
    expect(sideOf("innerCopper")).toBe("both");
    expect(sideOf("other")).toBe("both");
  });
});

describe("layer map consistency", () => {
  // Every layer table must cover exactly the same set of layer types, so adding
  // a new type can't silently miss a colour / z-index / ordering slot.
  const canonical = Object.keys(DEFAULT_LAYER_COLORS).sort();
  const asStrings = (a: readonly LayerType[]) => a.map((t) => t as string).sort();

  it("LAYER_STACK_ORDER covers every layer type exactly once", () => {
    expect(asStrings(LAYER_STACK_ORDER)).toEqual(canonical);
    expect(LAYER_STACK_ORDER.length).toBe(new Set(LAYER_STACK_ORDER).size);
  });

  it("LAYER_ORDER covers every layer type exactly once", () => {
    expect(asStrings(LAYER_ORDER)).toEqual(canonical);
    expect(LAYER_ORDER.length).toBe(new Set(LAYER_ORDER).size);
  });

  it("LAYER_Z has a z-index for every layer type", () => {
    expect(Object.keys(LAYER_Z).sort()).toEqual(canonical);
  });
});
