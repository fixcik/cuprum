import { describe, it, expect } from "vitest";
import { buildStackLayers, type StackLayerFile } from "@/lib/stackLayers";
import { colorFor } from "@/lib/layerColors";
import type { GerberFile, LayerType } from "@/lib/api";

const g = (path: string, layer_type: LayerType): GerberFile => ({ path, layer_type });
const f = (over: Partial<StackLayerFile> = {}): StackLayerFile => ({
  svgBody: "<g/>",
  bbox: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  snap: [],
  ...over,
});
const ctx = (over = {}) => ({ excludeMask: false, isVisible: () => true, ...over });

describe("buildStackLayers", () => {
  it("builds one layer per gerber that has a rendered svg + bbox", () => {
    const out = buildStackLayers([g("a.gtl", "topCopper")], [f()], ctx());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: "a.gtl", type: "topCopper", visible: true, svgBody: "<g/>" });
    expect(out[0].color).toBe(colorFor("topCopper", undefined));
  });

  it("skips gerbers whose svg or bbox hasn't loaded yet", () => {
    const out = buildStackLayers(
      [g("a.gtl", "topCopper"), g("b.gbl", "bottomCopper")],
      [f({ svgBody: undefined }), f({ bbox: undefined })],
      ctx(),
    );
    expect(out).toEqual([]);
  });

  it("omits mask layers when excludeMask is set", () => {
    const gerbers = [g("c.gts", "topMask"), g("d.gbs", "bottomMask"), g("a.gtl", "topCopper")];
    const files = [f(), f(), f()];
    expect(buildStackLayers(gerbers, files, ctx({ excludeMask: true })).map((l) => l.type)).toEqual(["topCopper"]);
    expect(buildStackLayers(gerbers, files, ctx({ excludeMask: false })).map((l) => l.type)).toEqual([
      "topMask",
      "bottomMask",
      "topCopper",
    ]);
  });

  it("carries the visibility predicate's verdict per layer", () => {
    const out = buildStackLayers(
      [g("a.gtl", "topCopper"), g("b.gbl", "bottomCopper")],
      [f(), f()],
      ctx({ isVisible: (_t: LayerType, path: string) => path === "a.gtl" }),
    );
    expect(out.map((l) => l.visible)).toEqual([true, false]);
  });

  it("applies colour overrides", () => {
    const overrides = { topCopper: "#123456" };
    const out = buildStackLayers([g("a.gtl", "topCopper")], [f()], ctx({ overrides }));
    expect(out[0].color).toBe(colorFor("topCopper", overrides));
  });
});
