import { describe, it, expect } from "vitest";
import {
  buildDrcMarkers,
  markerShapeFor,
  projectMarkers,
  markerPaintOrder,
  boxPlacement,
  circlePlacement,
  dimTicks,
  hitboxPlacement,
  type DrcText,
  type MarkerViewport,
} from "@/lib/drcMarkers";
import type { Finding, FindingCategory } from "@/lib/feasibility";
import type { GeoHotspot } from "@/lib/api";
import type { DrcMarkerInput, ProjectedMarker } from "@/components/preview/DrcMarkers";

// Identity-ish formatters so assertions read directly off the inputs.
const text: DrcText = {
  resolveText: (t) => (t ? t.key : ""),
  trLen: (t, ls) => (t ? `${t.key}|${ls}` : ""),
  fmtLen: (mm) => `${mm}mm`,
  fmtLenPair: (vals) => vals.map((v) => `${v}mm`),
};
const allVisible = () => true;

const hs = (over: Partial<GeoHotspot> = {}): GeoHotspot => ({ a: [0, 0], b: [1, 1], v: 0.2, side: "top", ...over });

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "copper.minSpace",
  category: "copper",
  severity: "block",
  label: { key: "lbl" },
  ...over,
});

describe("markerShapeFor", () => {
  it("maps hole findings to a circle", () => {
    expect(markerShapeFor("drill.minHole")).toBe("circle");
    expect(markerShapeFor("via.plating")).toBe("circle");
    expect(markerShapeFor("drill.bitSnap")).toBe("circle");
  });
  it("maps stroke families to a line by prefix", () => {
    expect(markerShapeFor("silk.line.top")).toBe("line");
    expect(markerShapeFor("copper.thinTrace")).toBe("line");
  });
  it("falls back to dim", () => {
    expect(markerShapeFor("copper.minSpace")).toBe("dim");
  });
});

describe("buildDrcMarkers", () => {
  const ctx = (over = {}) => ({ focus: null, markerVisible: allVisible, text, ...over });

  it("emits one marker per visible hotspot, keyed by finding id + index", () => {
    const out = buildDrcMarkers([finding({ hotspots: [hs(), hs({ v: 0.3 })] })], ctx());
    expect(out.map((m) => m.key)).toEqual(["copper.minSpace#0", "copper.minSpace#1"]);
    expect(out[0]).toMatchObject({ shape: "dim", value: "0.2mm", label: "lbl", severity: "block" });
  });

  it("drops hotspots the visibility predicate rejects", () => {
    const onlyBottom = (_c: FindingCategory, side: "top" | "bottom" | "both") => side === "bottom";
    const out = buildDrcMarkers(
      [finding({ hotspots: [hs({ side: "top" }), hs({ side: "bottom" })] })],
      ctx({ markerVisible: onlyBottom }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("copper.minSpace#1");
  });

  it("drops a finding whose problem type is hidden", () => {
    const out = buildDrcMarkers(
      [finding({ id: "drill.minHole", category: "drill", hotspots: [hs()] })],
      ctx({ hiddenTypes: new Set(["drill"]) }),
    );
    expect(out).toEqual([]);
  });

  it("marks the focused hotspot (non-line) and never a line", () => {
    const dim = buildDrcMarkers([finding({ hotspots: [hs(), hs()] })], ctx({ focus: { fid: "copper.minSpace", hi: 1 } }));
    expect(dim.map((m) => m.focused)).toEqual([false, true]);

    const line = buildDrcMarkers(
      [finding({ id: "copper.thinTrace", hotspots: [hs({ v: 0.1 })] })],
      ctx({ focus: { fid: "copper.thinTrace", hi: 0 } }),
    );
    expect(line[0]).toMatchObject({ shape: "line", focused: false, widthMm: 0.1, lineColor: "hsl(var(--destructive))" });
  });

  it("formats value/limit via the length pair when the limit carries a length", () => {
    const out = buildDrcMarkers(
      [finding({ limit: { key: "lim", params: { len: 0.15 } }, hotspots: [hs({ v: 0.1 })] })],
      ctx(),
    );
    expect(out[0].value).toBe("0.1mm");
    expect(out[0].limit).toBe("lim|0.15mm");
  });

  it("appends hover-box markers after the visual ones", () => {
    const out = buildDrcMarkers([finding({ hotspots: [hs()], hoverBoxes: [hs({ v: 0.5 })] })], ctx());
    expect(out.map((m) => m.shape)).toEqual(["dim", "hover"]);
    expect(out[1].key).toBe("copper.minSpace~hover#0");
  });
});

// Minimal projected marker for the placement helpers: only the px fields matter.
const pm = (over: Partial<ProjectedMarker> = {}): ProjectedMarker => ({
  key: "k",
  ax: 0,
  ay: 0,
  bx: 0,
  by: 0,
  mx: 0,
  my: 0,
  value: "v",
  label: "l",
  limit: "lim",
  severity: "block",
  focused: false,
  ...over,
});

const mk = (over: Partial<DrcMarkerInput> = {}): DrcMarkerInput => ({
  key: "k",
  a: [0, 0],
  b: [0, 0],
  value: "v",
  label: "l",
  limit: "lim",
  severity: "block",
  focused: false,
  ...over,
});

describe("projectMarkers", () => {
  const vp = (over: Partial<MarkerViewport> = {}): MarkerViewport => ({
    s: 2,
    tx: 10,
    ty: 20,
    minX: 0,
    minY: 0,
    maxX: 100,
    maxY: 50,
    mirrored: false,
    ...over,
  });

  it("projects a/b/mid mm→px with the Y-flip on the board extent", () => {
    const [m] = projectMarkers([mk({ a: [10, 10], b: [30, 40] })], vp());
    // x = tx + s·gx ; y = ty + s·(maxY+minY − gy)
    expect([m.ax, m.ay]).toEqual([30, 100]);
    expect([m.bx, m.by]).toEqual([70, 40]);
    // midpoint of a..b, projected
    expect([m.mx, m.my]).toEqual([50, 70]);
  });

  it("mirrors X across the board extent when mirrored", () => {
    const [m] = projectMarkers([mk({ a: [10, 10], b: [30, 40] })], vp({ mirrored: true }));
    // x = tx + s·(maxX+minX − gx)
    expect(m.ax).toBe(190);
    expect(m.bx).toBe(150);
    // Y is unaffected by the X mirror
    expect(m.ay).toBe(100);
  });

  it("projects widthMm→widthPx at scale, leaving it undefined otherwise", () => {
    const [withW] = projectMarkers([mk({ widthMm: 0.5 })], vp());
    expect(withW.widthPx).toBe(1);
    const [noW] = projectMarkers([mk()], vp());
    expect(noW.widthPx).toBeUndefined();
  });

  it("carries through non-geometric fields and the marker key", () => {
    const [m] = projectMarkers([mk({ key: "f#0", shape: "line", lineColor: "#abc" })], vp());
    expect(m.key).toBe("f#0");
    expect(m.shape).toBe("line");
    expect(m.lineColor).toBe("#abc");
  });
});

describe("markerPaintOrder", () => {
  it("sorts line markers before the rest, without mutating the input", () => {
    const input = [pm({ key: "dim", shape: "dim" }), pm({ key: "ln", shape: "line" }), pm({ key: "box", shape: "box" })];
    const out = markerPaintOrder(input);
    expect(out.map((m) => m.key)).toEqual(["ln", "dim", "box"]);
    // stable for non-line entries, and a fresh array
    expect(input.map((m) => m.key)).toEqual(["dim", "ln", "box"]);
  });
});

describe("boxPlacement", () => {
  it("pads the a..b bbox and centres the box on it", () => {
    // bbox x:[10,30] y:[40,60] → pad 6 → [4,24]×[34,66] (24×32, above min)
    const b = boxPlacement(pm({ ax: 10, ay: 40, bx: 30, by: 60 }), 6, 16);
    expect([b.cx, b.cy]).toEqual([20, 50]);
    expect([b.w, b.h]).toEqual([32, 32]);
    expect([b.x, b.y]).toEqual([4, 34]);
    // label anchor: 5px right of the right edge, at the top
    expect([b.labelX, b.labelY]).toEqual([41, 34]);
  });

  it("floors a tiny bbox at the minimum size, kept centred", () => {
    // a degenerate point → padded 12×12, floored to 16×16
    const b = boxPlacement(pm({ ax: 50, ay: 50, bx: 50, by: 50 }), 6, 16);
    expect([b.w, b.h]).toEqual([16, 16]);
    expect([b.cx, b.cy]).toEqual([50, 50]);
    expect([b.x, b.y]).toEqual([42, 42]);
  });
});

describe("circlePlacement", () => {
  it("centres on the bbox with r = half the larger side", () => {
    const c = circlePlacement(pm({ ax: 10, ay: 20, bx: 30, by: 80 }), 8);
    expect([c.cx, c.cy]).toEqual([20, 50]);
    expect(c.r).toBe(30); // max(|Δx|=20,|Δy|=60)/2 = 30
    expect([c.labelX, c.labelY]).toEqual([55, 20]); // cx+r+5, cy−r
  });

  it("floors the radius at the minimum", () => {
    const c = circlePlacement(pm({ ax: 0, ay: 0, bx: 4, by: 4 }), 8);
    expect(c.r).toBe(8);
  });
});

describe("dimTicks", () => {
  it("returns the perpendicular unit times the tick half-length", () => {
    // horizontal a→b → perpendicular is vertical
    const t = dimTicks(pm({ ax: 0, ay: 0, bx: 10, by: 0 }), 7);
    expect(t.len).toBe(10);
    expect(t.tx).toBeCloseTo(0);
    expect(t.ty).toBeCloseTo(7);
  });

  it("guards a zero-length marker against divide-by-zero", () => {
    const t = dimTicks(pm({ ax: 5, ay: 5, bx: 5, by: 5 }), 4);
    expect(t.len).toBe(1);
    expect(Number.isFinite(t.tx)).toBe(true);
    expect(Number.isFinite(t.ty)).toBe(true);
  });
});

describe("hitboxPlacement", () => {
  it("pads each side and centres on the bbox", () => {
    // bbox x:[10,30] y:[40,80] → +pad 8 each side → 36×56
    const h = hitboxPlacement(pm({ ax: 10, ay: 40, bx: 30, by: 80 }), 8, 16);
    expect([h.cx, h.cy]).toEqual([20, 60]);
    expect([h.w, h.h]).toEqual([36, 56]);
  });

  it("floors a small hitbox at the minimum size", () => {
    const h = hitboxPlacement(pm({ ax: 50, ay: 50, bx: 50, by: 50 }), 0, 16);
    expect([h.w, h.h]).toEqual([16, 16]);
    expect([h.cx, h.cy]).toEqual([50, 50]);
  });
});
