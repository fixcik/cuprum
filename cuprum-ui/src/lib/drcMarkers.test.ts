import { describe, it, expect } from "vitest";
import { buildDrcMarkers, markerShapeFor, type DrcText } from "@/lib/drcMarkers";
import type { Finding, FindingCategory } from "@/lib/feasibility";
import type { GeoHotspot } from "@/lib/api";

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
