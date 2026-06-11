import { describe, expect, it } from "vitest";
import type { BBox, LayerType } from "@/lib/api";
import {
  boardSnapPoints,
  edgeCenterlineBBox,
  featureSnapPoints,
  findEdgeLayer,
  visibleLayersInZOrder,
  type ClassifiableLayer,
} from "@/lib/layerClassification";

function layer(type: LayerType, over: Partial<ClassifiableLayer> = {}): ClassifiableLayer {
  return {
    svgBody: "",
    bbox: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
    visible: true,
    type,
    snap: [],
    ...over,
  };
}

describe("visibleLayersInZOrder", () => {
  it("drops hidden layers and sorts the rest by painter's z (edge under, drill on top)", () => {
    const layers = [
      layer("topSilk"),
      layer("topCopper"),
      layer("bottomMask", { visible: false }),
      layer("edgeCuts"),
      layer("drill"),
    ];
    const got = visibleLayersInZOrder(layers).map((l) => l.type);
    // edgeCuts (-1) → topCopper (6) → topSilk (8) → drill (10); bottomMask hidden.
    expect(got).toEqual(["edgeCuts", "topCopper", "topSilk", "drill"]);
  });

  it("does not mutate the input array order", () => {
    const layers = [layer("drill"), layer("edgeCuts")];
    const before = layers.map((l) => l.type);
    visibleLayersInZOrder(layers);
    expect(layers.map((l) => l.type)).toEqual(before);
  });

  it("returns empty for an empty stack", () => {
    expect(visibleLayersInZOrder([])).toEqual([]);
  });

  it("keeps an unknown/other type (z=0, drawn underneath) when visible", () => {
    const got = visibleLayersInZOrder([layer("other"), layer("topCopper")]).map((l) => l.type);
    // other (0) sorts before topCopper (6).
    expect(got).toEqual(["other", "topCopper"]);
  });
});

describe("findEdgeLayer", () => {
  it("finds the edgeCuts layer", () => {
    const edge = layer("edgeCuts", { svgBody: "EDGE" });
    expect(findEdgeLayer([layer("topCopper"), edge])).toBe(edge);
  });

  it("returns undefined when no outline is assigned", () => {
    expect(findEdgeLayer([layer("topCopper"), layer("drill")])).toBeUndefined();
  });
});

describe("edgeCenterlineBBox", () => {
  // Mirror the shape the renderer (cuprum-gerber/src/svg.rs) emits for Edge_Cuts:
  // stroked <path> segments in a <g stroke> that stitch into a closed loop.
  const seg = (x1: number, y1: number, x2: number, y2: number) =>
    `<path d="M${x1} ${y1} L${x2} ${y2}" fill="none" stroke-width="0.1"/>`;
  const wrap = (inner: string) => `<g stroke="currentColor">${inner}</g>`;
  // A 10×4 rectangle outline; the centerline corners are 0,0 and 10,4.
  const rect = wrap(seg(0, 0, 10, 0) + seg(10, 0, 10, 4) + seg(10, 4, 0, 4) + seg(0, 4, 0, 0));

  it("returns the bbox of the outline centerline loop", () => {
    expect(edgeCenterlineBBox(rect)).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 4 });
  });

  it("returns null for null/undefined input", () => {
    expect(edgeCenterlineBBox(null)).toBeNull();
    expect(edgeCenterlineBBox(undefined)).toBeNull();
  });

  it("returns null when the svg has no outline loops", () => {
    expect(edgeCenterlineBBox("<g></g>")).toBeNull();
  });
});

describe("featureSnapPoints", () => {
  it("flattens snap points across the visible layers", () => {
    const layers = [
      layer("topCopper", { snap: [[1, 2], [3, 4]] }),
      layer("drill", { snap: [[5, 6]] }),
      layer("edgeCuts", { snap: [] }),
    ];
    expect(featureSnapPoints(layers)).toEqual([[1, 2], [3, 4], [5, 6]]);
  });

  it("returns empty when no layer contributes points", () => {
    expect(featureSnapPoints([layer("topCopper")])).toEqual([]);
  });
});

describe("boardSnapPoints", () => {
  it("returns the 4 corners, 4 edge midpoints and the centre", () => {
    const bx: BBox = { minX: 0, minY: 0, maxX: 10, maxY: 4 };
    expect(boardSnapPoints(bx)).toEqual([
      [0, 0], [10, 0], [0, 4], [10, 4], // corners
      [5, 0], [5, 4], // top/bottom edge midpoints
      [0, 2], [10, 2], // left/right edge midpoints
      [5, 2], // centre
    ]);
  });
});
