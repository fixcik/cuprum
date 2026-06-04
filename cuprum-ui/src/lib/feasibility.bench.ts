import { bench, describe } from "vitest";
import { evaluate, problemTypeOf, type Finding } from "@/lib/feasibility";
import type { BoardMetrics, GeoHotspot } from "@/lib/api";
import { DEFAULT_PROFILE } from "@/lib/capabilityProfile";
import i18n from "@/i18n";

// Worst-case dense board: every located-hotspot family filled to the HOT_N=500
// cap (PR #79), split across top/bottom so per-side findings (silk, thin-trace)
// and the O(n²) silk clusterBoxes run at full size. This is the upper bound of
// the per-recompute main-thread work the roadmap item worried about; if it's
// well under a frame budget here, a Web Worker is unjustified.
const HOT_N = 500;

/** N hotspots at value `v` on `side`, spread out so silk clustering does real
 *  work (distinct midpoints → many union-find groups, not one trivial blob). */
const hots = (n: number, v: number, side: GeoHotspot["side"]): GeoHotspot[] =>
  Array.from({ length: n }, (_, i) => {
    const x = (i % 50) * 2;
    const y = Math.floor(i / 50) * 2;
    return { a: [x, y], b: [x + 1, y + 1], v, side } as GeoHotspot;
  });

const denseMetrics = (): BoardMetrics => ({
  board: { widthMm: 50, heightMm: 40, originXMm: 0, originYMm: 0, outlineClosed: true, cutoutCount: 0, hasEdgeLayer: true },
  layers: {
    copperTop: true,
    copperBottom: true,
    innerCopperCount: 0,
    hasMaskTop: true,
    hasMaskBottom: true,
    hasSilkTop: true,
    hasSilkBottom: true,
    hasPaste: false,
    copperLayerCount: 2,
  },
  copper: [],
  drill: {
    totalHoles: HOT_N,
    uniqueToolDiametersMm: [0.7], // arbitrary diameter; bit-snap is not exercised in the bench
    minHoleMm: 0.2,
    platedHoleCount: HOT_N,
    nonplatedHoleCount: 0,
    diameterHistogram: [],
  },
  geo: {
    copperCoveragePct: 40,
    minSilkLineMm: 0.1,
    silkLineWidthsMm: [0.1],
    minClearanceMm: 0.1,
    minCopperWidthMm: 0.1,
    minAnnularMm: 0.1,
    minMaskDamMm: 0.07,
    layerOvershootMm: 0.3,
    slotCount: 2,
    minSlotWidthMm: 0.5,
    // clearance / width violations (0.05 <= v < 0.15)
    clearanceHotspots: [...hots(HOT_N / 2, 0.1, "top"), ...hots(HOT_N / 2, 0.1, "bottom")],
    copperWidthHotspots: [...hots(HOT_N / 2, 0.1, "top"), ...hots(HOT_N / 2, 0.1, "bottom")],
    // thin-trace: conds (hoverBoxes) + segs (hotspots), per side
    thinTraceConductors: [...hots(HOT_N / 2, 0.1, "top"), ...hots(HOT_N / 2, 0.1, "bottom")],
    traceHotspots: [...hots(HOT_N / 2, 0.1, "top"), ...hots(HOT_N / 2, 0.1, "bottom")],
    traceCount: HOT_N,
    traceTotalLengthMm: 1000,
    // silk: failing → clusterBoxes O(n²) per side
    silkHotspots: [...hots(HOT_N / 2, 0.1, "top"), ...hots(HOT_N / 2, 0.1, "bottom")],
    annularHotspots: hots(HOT_N, 0.1, "both"),
    maskDamHotspots: hots(HOT_N, 0.07, "top"),
    overshootHotspots: hots(HOT_N, 0.3, "both"),
    drillHotspots: hots(HOT_N, 0.7, "both"),
  },
});

const profile = DEFAULT_PROFILE;
const t = i18n.t.bind(i18n);
const fmtLen = (mm: number) => `${mm.toFixed(3)} mm`;

/** Faithful copy of usePreviewData's markers+issues hot-loop, including the real
 *  i18n.t() string resolution per hotspot (the dominant cost there). */
function deriveMarkersAndIssues(findings: Finding[]) {
  const markers: unknown[] = [];
  const issues: unknown[] = [];
  for (const f of findings) {
    const tp = problemTypeOf(f.id);
    void tp;
    const label = t(f.label.key, f.label.params as Record<string, unknown>);
    const limit = f.limit ? t(f.limit.key, f.limit.params as Record<string, unknown>) : "";
    const detail = f.detail ? t(f.detail.key, f.detail.params as Record<string, unknown>) : undefined;
    for (let i = 0; i < (f.hotspots?.length ?? 0); i++) {
      const h = f.hotspots![i];
      markers.push({ key: `${f.id}#${i}`, a: h.a, b: h.b, value: fmtLen(h.v), label, limit, detail, severity: f.severity });
      issues.push({ fid: f.id, hi: i, label, value: fmtLen(h.v), severity: f.severity });
    }
    for (let i = 0; i < (f.hoverBoxes?.length ?? 0); i++) {
      const h = f.hoverBoxes![i];
      markers.push({ key: `${f.id}~hover#${i}`, a: h.a, b: h.b, value: fmtLen(h.v), label, limit, detail, severity: f.severity });
    }
  }
  return { markers, issues };
}

describe("feasibility worst-case (500/family)", () => {
  // Sanity: log the workload size once (bench output omits it otherwise).
  const f0 = evaluate(denseMetrics(), profile);
  const totalHot = f0.reduce((n, f) => n + (f.hotspots?.length ?? 0) + (f.hoverBoxes?.length ?? 0), 0);
  // eslint-disable-next-line no-console
  console.log(`[bench] findings=${f0.length} totalHotspots+hovers=${totalHot}`);

  bench("evaluate() only", () => {
    evaluate(denseMetrics(), profile);
  });

  bench("derive markers+issues (with i18n.t)", () => {
    deriveMarkersAndIssues(f0);
  });

  bench("evaluate + derive (full per-recompute)", () => {
    const findings = evaluate(denseMetrics(), profile);
    deriveMarkersAndIssues(findings);
  });
});
