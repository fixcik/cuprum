import type { BoardMetrics, GeoHotspot } from "@/lib/api";
import type { CapabilityProfile } from "@/lib/capabilityProfile";

/** A finding's severity. `info` is advisory — shown, but never escalates the
 *  overall verdict (used for secondary layers like mask/silk that don't affect
 *  whether the board can be produced). */
export type Severity = "ok" | "warn" | "block" | "info";
/** The overall verdict can only be one of these (info never escalates). */
export type Verdict = "ok" | "warn" | "block";
export type FindingCategory = "size" | "layers" | "copper" | "drill" | "via" | "mask" | "silk";

/** A translatable text: an i18n key plus optional interpolation params.
 *  Length params are RAW MILLIMETRES — formatted at render via useUnitFormat. */
export interface I18nText {
  key: string;
  params?: Record<string, string | number>;
}

/** One DFM check: a measured value compared against a profile limit. */
export interface Finding {
  id: string;
  category: FindingCategory;
  severity: Severity;
  label: I18nText;
  measured?: I18nText;
  limit?: I18nText;
  detail?: I18nText;
  /** Located instances of this issue for preview markers. */
  hotspots?: GeoHotspot[];
  /** When set, the hotspots are the FULL failing geometry to colour-highlight all
   *  at once (e.g. every thin silk stroke) rather than step through — the preview
   *  tints them and the Feasibility row drops the per-item stepper. */
  highlightAll?: boolean;
  /** Invisible hover regions (cluster bboxes) so a tooltip pops on hovering any
   *  part of a line-highlighted feature — without one hitbox per stroke. */
  hoverBoxes?: GeoHotspot[];
}

/** Midpoint of a hotspot's two points. */
const hsMid = (h: GeoHotspot): [number, number] => [(h.a[0] + h.b[0]) / 2, (h.a[1] + h.b[1]) / 2];

/** Collapse a swarm of failing strokes into one bounding box per connected group
 *  (strokes whose midpoints are within `radius` mm chain together). A silk text
 *  block becomes a single rectangle covering all its letters; separate silk
 *  elsewhere stays its own box. Grouped per side (top/bottom never merge). The
 *  box value is the worst (thinnest) stroke in the group. */
function clusterBoxes(hs: GeoHotspot[], radius: number): GeoHotspot[] {
  const out: GeoHotspot[] = [];
  const bySide = new Map<string, GeoHotspot[]>();
  for (const h of hs) {
    const arr = bySide.get(h.side) ?? [];
    arr.push(h);
    bySide.set(h.side, arr);
  }
  for (const [side, group] of bySide) {
    const n = group.length;
    const mids = group.map(hsMid);
    // Union-find: connect strokes whose midpoints are within `radius`.
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
    const r2 = radius * radius;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = mids[i][0] - mids[j][0];
        const dy = mids[i][1] - mids[j][1];
        if (dx * dx + dy * dy < r2) parent[find(i)] = find(j);
      }
    }
    const groups = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      const arr = groups.get(r) ?? [];
      arr.push(i);
      groups.set(r, arr);
    }
    for (const idxs of groups.values()) {
      let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, minV = Infinity;
      for (const i of idxs) {
        const h = group[i];
        for (const p of [h.a, h.b]) {
          minx = Math.min(minx, p[0]);
          miny = Math.min(miny, p[1]);
          maxx = Math.max(maxx, p[0]);
          maxy = Math.max(maxy, p[1]);
        }
        minV = Math.min(minV, h.v);
      }
      out.push({ a: [minx, miny], b: [maxx, maxy], v: minV, side: side as GeoHotspot["side"] });
    }
  }
  return out;
}

/** Trim a number without trailing zeros, keeping enough precision for small
 *  values so a thin 0.004 mm feature doesn't read as a flat "0". */
const n = (v: number) => {
  const a = Math.abs(v);
  return a > 0 && a < 0.1 ? `${+v.toFixed(3)}` : `${+v.toFixed(2)}`;
};

/** Format a length, switching to microns for sub-0.1 mm values so a tiny gap
 *  reads as "12 µm" instead of a misleading "0 mm". */
export const fmtLen = (mm: number): string => {
  const a = Math.abs(mm);
  if (a > 0 && a < 0.1) return `${Math.round(mm * 1000)} мкм`;
  return `${n(mm)} мм`;
};

/** Smallest width ≥ `floor` from a sorted-ascending list, or null. Drops tiny
 *  artefact apertures (a 10 µm marker) before taking the min, so a single such
 *  stroke doesn't poison the metric and hide a real thin feature. */
export const minAbove = (widths: number[], floor: number): number | null => {
  for (const w of widths) if (w >= floor) return w;
  return null;
};

/** Count holes treated as "vias" by the heuristic (diameter ≤ threshold). */
function viaCount(metrics: BoardMetrics, maxDiaMm: number): number {
  return metrics.drill.diameterHistogram.reduce((sum, [d, c]) => (d <= maxDiaMm ? sum + c : sum), 0);
}

/** Judge measured board metrics against the machine capability profile. Returns
 *  one Phase-1 finding per applicable check (Phase 2/3 checks are omitted). */
export function evaluate(metrics: BoardMetrics | null, profile: CapabilityProfile): Finding[] {
  if (!metrics) return [];
  const out: Finding[] = [];
  const { board, layers, copper, drill } = metrics;

  // --- Size: fits the max panel (try rotated if allowed) ---
  if (board.hasEdgeLayer) {
    const { widthMm: w, heightMm: h } = board;
    const { maxPanelWidthMm: mw, maxPanelHeightMm: mh } = profile;
    const fitsDirect = w <= mw && h <= mh;
    const fitsRotated = h <= mw && w <= mh;
    const label: I18nText = { key: "feasibility:size.label" };
    const measured: I18nText = { key: "feasibility:size.measured", params: { w, h } };
    const limit: I18nText = { key: "feasibility:size.limit", params: { w: mw, h: mh } };
    if (fitsDirect) {
      out.push({ id: "size.fits", category: "size", severity: "ok", label, measured, limit });
    } else if (profile.allowRotateToFit && fitsRotated) {
      out.push({
        id: "size.fits",
        category: "size",
        severity: "warn",
        label,
        measured,
        limit,
        detail: { key: "feasibility:size.rotated" },
      });
    } else {
      out.push({
        id: "size.fits",
        category: "size",
        severity: "block",
        label,
        measured,
        limit,
        detail: { key: "feasibility:size.tooBig" },
      });
    }

    // --- Outline closed (open → size is an estimate) ---
    out.push({
      id: "size.outlineClosed",
      category: "size",
      severity: board.outlineClosed ? "ok" : "warn",
      label: { key: "feasibility:outline.label" },
      measured: { key: board.outlineClosed ? "common:yes" : "common:no" },
      limit: { key: "feasibility:outline.limit" },
      detail: board.outlineClosed ? undefined : { key: "feasibility:outline.open" },
    });
  }

  // --- Layer count ---
  out.push({
    id: "layers.count",
    category: "layers",
    severity: layers.copperLayerCount > profile.maxCopperLayers ? "block" : "ok",
    label: { key: "feasibility:layers.count.label" },
    measured: { key: "feasibility:raw", params: { v: layers.copperLayerCount } },
    limit: { key: "feasibility:lteCount", params: { v: profile.maxCopperLayers } },
    detail:
      layers.copperLayerCount > profile.maxCopperLayers
        ? { key: "feasibility:layers.count.over" }
        : undefined,
  });

  // --- Inner layers ---
  if (layers.innerCopperCount > 0 || !profile.allowInnerLayers) {
    const bad = layers.innerCopperCount > 0 && !profile.allowInnerLayers;
    out.push({
      id: "layers.inner",
      category: "layers",
      severity: bad ? "block" : "ok",
      label: { key: "feasibility:layers.inner.label" },
      measured: { key: "feasibility:raw", params: { v: layers.innerCopperCount } },
      limit: { key: profile.allowInnerLayers ? "feasibility:layers.inner.allowed" : "feasibility:layers.inner.unsupported" },
      detail: bad ? { key: "feasibility:layers.inner.bad" } : undefined,
    });
  }

  // --- Minimum trace width (narrowest non-artefact stroke across copper layers) ---
  const traces = copper
    .map((c) => ({ side: c.side, w: minAbove(c.traceWidthsMm, profile.ignoreBelowMm) }))
    .filter((c) => c.w != null) as { side: "top" | "bottom" | "inner"; w: number }[];
  if (traces.length > 0) {
    const worst = traces.reduce((a, b) => (b.w < a.w ? b : a));
    const t = worst.w;
    const lim = profile.minTraceMm;
    const sideKey =
      worst.side === "top" ? "feasibility:side.top" : worst.side === "bottom" ? "feasibility:side.bottom" : "feasibility:side.inner";
    let severity: Severity = "ok";
    if (t < lim) severity = "block";
    else if (t < lim / 0.8) severity = "warn"; // within 80–100% of the limit
    const traceHs = metrics.geo.traceHotspots.filter((h) => h.v >= profile.ignoreBelowMm && h.v < lim);
    out.push({
      id: "copper.minTrace",
      category: "copper",
      severity,
      label: { key: "feasibility:trace.label" },
      measured: { key: "feasibility:trace.measured", params: { len: t, side: sideKey } },
      limit: { key: "feasibility:gteLen", params: { len: lim } },
      detail: severity === "block" ? { key: "feasibility:trace.tooThin" } : undefined,
      hotspots: clusterBoxes(traceHs, 1.5),
    });
  }

  // --- Minimum hole size (the user's own floor, separate from the bit set) ---
  if (drill.minHoleMm != null) {
    const d = drill.minHoleMm;
    const tooSmall = d < profile.minDrillMm;
    out.push({
      id: "drill.minHole",
      category: "drill",
      severity: tooSmall ? "block" : "ok",
      label: { key: "feasibility:drill.minHole.label" },
      measured: { key: "feasibility:lenOnly", params: { len: d } },
      limit: { key: "feasibility:gteLen", params: { len: profile.minDrillMm } },
      detail: tooSmall ? { key: "feasibility:drill.minHole.tooSmall" } : undefined,
      hotspots: (metrics.geo.drillHotspots ?? []).filter((h) => h.v < profile.minDrillMm),
    });
  }

  // --- Via plating (heuristic: small holes that would need plating) ---
  if (!profile.viaPlatingAvailable) {
    const vias = viaCount(metrics, profile.viaMaxDiameterMm);
    let severity: Severity = "ok";
    if (vias >= profile.viaBlockCount) severity = "block";
    else if (vias >= profile.viaWarnCount) severity = "warn";
    out.push({
      id: "via.plating",
      category: "via",
      severity,
      label: { key: "feasibility:via.label" },
      measured: { key: "feasibility:via.measured", params: { v: vias } },
      limit: { key: "feasibility:via.limit" },
      detail:
        severity === "ok"
          ? undefined
          : { key: "feasibility:via.detail", params: { v: vias, len: profile.viaMaxDiameterMm } },
      hotspots: severity === "ok" ? undefined : (metrics.geo.drillHotspots ?? []).filter((h) => h.v <= profile.viaMaxDiameterMm),
    });
  }

  // --- Geometric checks (Phase 2/3); each shown only when measured ---
  const g = metrics.geo;

  // Distance-based copper/mask issues: ignore sub-`ignoreBelowMm` artefacts
  // (degenerate slivers from the boolean ops), and only show a row on a real
  // violation; the worst remaining value is the measured one.
  const minBelow = (hs: GeoHotspot[]) => Math.min(...hs.map((h) => h.v));

  const clearViol = g.clearanceHotspots.filter((h) => h.v >= profile.ignoreBelowMm && h.v < profile.minSpaceMm);
  if (clearViol.length) {
    out.push({
      id: "copper.minSpace",
      category: "copper",
      severity: "block",
      label: { key: "feasibility:space.label" },
      measured: { key: "feasibility:lenOnly", params: { len: minBelow(clearViol) } },
      limit: { key: "feasibility:gteLen", params: { len: profile.minSpaceMm } },
      detail: { key: "feasibility:space.detail" },
      hotspots: clearViol,
    });
  }

  const sliverViol = g.copperWidthHotspots.filter((h) => h.v >= profile.ignoreBelowMm && h.v < profile.minTraceMm);
  if (sliverViol.length) {
    out.push({
      id: "copper.sliver",
      category: "copper",
      severity: "warn",
      label: { key: "feasibility:sliver.label" },
      measured: { key: "feasibility:lenOnly", params: { len: minBelow(sliverViol) } },
      limit: { key: "feasibility:gteLen", params: { len: profile.minTraceMm } },
      detail: { key: "feasibility:sliver.detail" },
      hotspots: sliverViol,
    });
  }

  if (g.minAnnularMm != null) {
    const a = g.minAnnularMm;
    const severity: Severity = a <= 0 ? "block" : a < profile.minAnnularRingMm ? "warn" : "ok";
    out.push({
      id: "copper.annular",
      category: "drill",
      severity,
      label: { key: "feasibility:annular.label" },
      measured: a <= 0 ? { key: "feasibility:annular.noPad" } : { key: "feasibility:lenOnly", params: { len: a } },
      limit: { key: "feasibility:gteLen", params: { len: profile.minAnnularRingMm } },
      detail:
        a <= 0
          ? { key: "feasibility:annular.noPadDetail" }
          : severity === "warn"
            ? { key: "feasibility:annular.narrow" }
            : undefined,
      hotspots: g.annularHotspots.filter((h) => h.v < profile.minAnnularRingMm),
    });
  }

  const maskViol = g.maskDamHotspots.filter((h) => h.v >= profile.ignoreBelowMm && h.v < profile.minMaskDamMm);
  if (maskViol.length) {
    out.push({
      id: "mask.dam",
      category: "mask",
      severity: "info",
      label: { key: "feasibility:mask.label" },
      measured: { key: "feasibility:lenOnly", params: { len: minBelow(maskViol) } },
      limit: { key: "feasibility:gteLen", params: { len: profile.minMaskDamMm } },
      detail: { key: "feasibility:mask.detail" },
      hotspots: maskViol,
    });
  }

  // Silk line width — judged PER SIDE (top vs bottom never merge into one row, so
  // a thin top legend isn't masked by a fine bottom one).
  const silkSideKey: Record<string, string> = {
    top: "feasibility:side.top",
    bottom: "feasibility:side.bottom",
    both: "feasibility:side.both",
  };
  for (const sd of [...new Set(g.silkHotspots.map((h) => h.side))]) {
    const sideHs = g.silkHotspots.filter((h) => h.side === sd && h.v >= profile.ignoreBelowMm);
    if (sideHs.length === 0) continue;
    const minW = Math.min(...sideHs.map((h) => h.v));
    if (minW >= profile.minSilkLineMm) continue;
    const failing = sideHs.filter((h) => h.v < profile.minSilkLineMm);
    out.push({
      id: `silk.line.${sd}`,
      category: "silk",
      severity: "info",
      label: { key: "feasibility:silk.label", params: { side: silkSideKey[sd] ?? sd } },
      measured: { key: "feasibility:lenOnly", params: { len: minW } },
      limit: { key: "feasibility:gteLen", params: { len: profile.minSilkLineMm } },
      detail: { key: "feasibility:silk.detail" },
      hotspots: failing,
      hoverBoxes: clusterBoxes(failing, 4),
      highlightAll: true,
    });
  }

  if (g.layerOvershootMm != null && g.layerOvershootMm > profile.maxOvershootMm) {
    out.push({
      id: "size.overshoot",
      category: "size",
      severity: "warn",
      label: { key: "feasibility:overshoot.label" },
      measured: { key: "feasibility:lenOnly", params: { len: g.layerOvershootMm } },
      limit: { key: "feasibility:lteLen", params: { len: profile.maxOvershootMm } },
      detail: { key: "feasibility:overshoot.detail" },
      hotspots: g.overshootHotspots.filter((h) => h.v > profile.maxOvershootMm),
    });
  }

  // Drill diameters that don't match any available bit (within tolerance).
  const offBits = metrics.drill.uniqueToolDiametersMm.filter(
    (d) => !profile.drillBitSetMm.some((bit) => Math.abs(d - bit) <= profile.drillBitToleranceMm),
  );
  if (offBits.length > 0) {
    out.push({
      id: "drill.bitSnap",
      category: "drill",
      severity: "warn",
      label: { key: "feasibility:bitSnap.label" },
      measured: { key: "feasibility:bitSnap.measured", params: { list: offBits.map(n).join(", ") } },
      limit: { key: "feasibility:bitSnap.limit" },
      detail: { key: "feasibility:bitSnap.detail" },
      hotspots: (g.drillHotspots ?? []).filter((h) => offBits.some((d) => Math.abs(h.v - d) < 0.0011)),
    });
  }

  if (g.slotCount > 0) {
    out.push({
      id: "drill.slots",
      category: "drill",
      severity: "ok",
      label: { key: "feasibility:slots.label" },
      measured: {
        key: g.minSlotWidthMm != null ? "feasibility:slots.measuredMin" : "feasibility:slots.measured",
        params: { count: g.slotCount, len: g.minSlotWidthMm ?? 0 },
      },
      limit: { key: "feasibility:slots.limit" },
    });
  }

  return out;
}

/** Overall verdict: block if any blocker, else warn if any risk, else ok.
 *  `info` findings are advisory and never escalate the verdict. */
export function overallVerdict(findings: Finding[]): Verdict {
  if (findings.some((f) => f.severity === "block")) return "block";
  if (findings.some((f) => f.severity === "warn")) return "warn";
  return "ok";
}

/** i18n key for a verdict (for the badge). */
export const VERDICT_KEY: Record<Verdict, string> = {
  ok: "feasibility:verdict.ok",
  warn: "feasibility:verdict.warn",
  block: "feasibility:verdict.block",
};
