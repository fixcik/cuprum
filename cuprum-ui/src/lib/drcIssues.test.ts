import { describe, it, expect } from "vitest";
import { buildDrcIssues } from "@/lib/drcIssues";
import type { Finding, FindingCategory } from "@/lib/feasibility";
import type { GeoHotspot } from "@/lib/api";

const hs = (over: Partial<GeoHotspot> = {}): GeoHotspot => ({ a: [0, 0], b: [1, 1], v: 0.2, side: "top", ...over });
const finding = (over: Partial<Finding> = {}): Finding => ({
  id: "copper.minSpace",
  category: "copper",
  severity: "warn",
  label: { key: "lbl" },
  ...over,
});
const ctx = (over = {}) => ({
  markerVisible: () => true,
  resolveText: (t?: { key: string }) => (t ? t.key : ""),
  fmtLen: (mm: number) => `${mm}mm`,
  ...over,
});

describe("buildDrcIssues", () => {
  it("emits one issue per visible hotspot", () => {
    const out = buildDrcIssues([finding({ hotspots: [hs(), hs({ v: 0.3 })] })], ctx());
    expect(out).toEqual([
      { fid: "copper.minSpace", hi: 0, label: "lbl", value: "0.2mm", severity: "warn" },
      { fid: "copper.minSpace", hi: 1, label: "lbl", value: "0.3mm", severity: "warn" },
    ]);
  });

  it("skips findings with no hotspots", () => {
    expect(buildDrcIssues([finding({ hotspots: [] })], ctx())).toEqual([]);
    expect(buildDrcIssues([finding({})], ctx())).toEqual([]);
  });

  it("drops a finding whose problem type is hidden", () => {
    const out = buildDrcIssues(
      [finding({ id: "silk.line.top", category: "silk", hotspots: [hs()] })],
      ctx({ hiddenTypes: new Set(["silk"]) }),
    );
    expect(out).toEqual([]);
  });

  it("filters by visibility predicate", () => {
    const onlyTop = (_c: FindingCategory, side: "top" | "bottom" | "both") => side === "top";
    const out = buildDrcIssues([finding({ hotspots: [hs({ side: "top" }), hs({ side: "bottom" })] })], ctx({ markerVisible: onlyTop }));
    expect(out).toHaveLength(1);
    expect(out[0].hi).toBe(0);
  });

  it("highlightAll with hover boxes yields one issue per box", () => {
    const out = buildDrcIssues(
      [finding({ highlightAll: true, hotspots: [hs()], hoverBoxes: [hs({ v: 0.4 }), hs({ v: 0.5 })] })],
      ctx(),
    );
    expect(out.map((i) => [i.hi, i.value])).toEqual([[0, "0.4mm"], [1, "0.5mm"]]);
  });

  it("highlightAll without hover boxes yields a single summary issue from `measured`", () => {
    const out = buildDrcIssues(
      [finding({ highlightAll: true, hotspots: [hs()], measured: { key: "meas" } })],
      ctx(),
    );
    expect(out).toEqual([{ fid: "copper.minSpace", hi: 0, label: "lbl", value: "meas", severity: "warn" }]);
  });
});
