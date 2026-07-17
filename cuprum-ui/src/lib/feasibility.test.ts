import { describe, it, expect } from "vitest";
import { evaluate, overallVerdict, minAbove, problemTypeOf, clusterBoxes, PROBLEM_TYPE_ORDER } from "@/lib/feasibility";
import type { Finding } from "@/lib/feasibility";
import type { BoardMetrics, GeoHotspot } from "@/lib/api";
import type { CapabilityProfile } from "@/lib/capabilityProfile";
import { DEFAULT_PROFILE } from "@/lib/capabilityProfile";

/** A capability profile with default machine limits; override per case. */
const makeProfile = (o: Partial<CapabilityProfile> = {}): CapabilityProfile => ({
  ...DEFAULT_PROFILE,
  ...o,
});

/** Per-section overrides for board metrics (each section merged shallowly). */
type MetricsOverride = {
  board?: Partial<BoardMetrics["board"]>;
  layers?: Partial<BoardMetrics["layers"]>;
  copper?: BoardMetrics["copper"];
  drill?: Partial<BoardMetrics["drill"]>;
  geo?: Partial<BoardMetrics["geo"]>;
};

/** A minimal, clean single-sided board that passes every check; override per case. */
const makeMetrics = (o: MetricsOverride = {}): BoardMetrics => {
  const base: BoardMetrics = {
    board: { widthMm: 50, heightMm: 40, originXMm: 0, originYMm: 0, outlineClosed: true, cutoutCount: 0, hasEdgeLayer: true },
    layers: {
      copperTop: true,
      copperBottom: false,
      innerCopperCount: 0,
      hasMaskTop: false,
      hasMaskBottom: false,
      hasSilkTop: false,
      hasSilkBottom: false,
      hasPaste: false,
      copperLayerCount: 1,
    },
    copper: [],
    drill: {
      totalHoles: 0,
      uniqueToolDiametersMm: [],
      minHoleMm: null,
      platedHoleCount: 0,
      nonplatedHoleCount: 0,
      diameterHistogram: [],
    },
    geo: {
      copperCoveragePct: null,
      minSilkLineMm: null,
      silkLineWidthsMm: [],
      minClearanceMm: null,
      minCopperWidthMm: null,
      minAnnularMm: null,
      minMaskDamMm: null,
      layerOvershootMm: null,
      slotCount: 0,
      minSlotWidthMm: null,
      clearanceHotspots: [],
      copperWidthHotspots: [],
      thinTraceConductors: [],
      traceCount: 0,
      traceTotalLengthMm: 0,
      annularHotspots: [],
      maskDamHotspots: [],
      overshootHotspots: [],
      silkHotspots: [],
      traceHotspots: [],
      drillHotspots: [],
    },
  };
  return {
    board: { ...base.board, ...o.board },
    layers: { ...base.layers, ...o.layers },
    copper: o.copper ?? base.copper,
    drill: { ...base.drill, ...o.drill },
    geo: { ...base.geo, ...o.geo },
  };
};

describe("minAbove", () => {
  it("returns the smallest width at or above the floor", () => {
    expect(minAbove([0.01, 0.1, 0.2], 0.05)).toBe(0.1);
  });

  it("drops sub-floor artefact apertures and returns null when none qualify", () => {
    expect(minAbove([0.01, 0.02], 0.05)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(minAbove([], 0.05)).toBeNull();
  });
});

describe("evaluate — size", () => {
  it("no size.fits finding when no panel is configured", () => {
    // Without a panel there is no reference dimension to compare against — skip the check.
    const findings = evaluate(makeMetrics(), makeProfile());
    const size = findings.find((f) => f.id === "size.fits");
    expect(size).toBeUndefined();
  });

  it("warns when it fits only rotated and rotation is allowed (panel present)", () => {
    // Board 90×150: direct 90≤160 but 150>100 → fails; rotated 150≤160 and 90≤100 → fits.
    const metrics = makeMetrics({ board: { widthMm: 90, heightMm: 150 } });
    const panel = { schema_version: 3, width_mm: 160, height_mm: 100, origin_x_mm: 0, origin_y_mm: 0, instances: [], tooling_holes: [], keep_out_zones: [], alignment_points: [], drill_class_overrides: {} };
    const findings = evaluate(metrics, makeProfile({ allowRotateToFit: true }), panel);
    const size = findings.find((f) => f.id === "size.fits");
    expect(size?.severity).toBe("warn");
  });

  it("blocks when the board does not fit the panel in any orientation", () => {
    const metrics = makeMetrics({ board: { widthMm: 250, heightMm: 250 } });
    const panel = { schema_version: 3, width_mm: 200, height_mm: 200, origin_x_mm: 0, origin_y_mm: 0, instances: [], tooling_holes: [], keep_out_zones: [], alignment_points: [], drill_class_overrides: {} };
    const findings = evaluate(metrics, makeProfile(), panel);
    const size = findings.find((f) => f.id === "size.fits");
    expect(size?.severity).toBe("block");
  });

  it("checks against the panel dimensions when a panel is configured", () => {
    const metrics = makeMetrics({ board: { widthMm: 70, heightMm: 40 } });
    const panel = {
      schema_version: 3,
      width_mm: 60,
      height_mm: 60,
      origin_x_mm: 0,
      origin_y_mm: 0,
      instances: [],
      tooling_holes: [],
      keep_out_zones: [],
      alignment_points: [],
      drill_class_overrides: {},
    };
    const findings = evaluate(metrics, makeProfile(), panel);
    const size = findings.find((f) => f.id === "size.fits");
    expect(size?.severity).toBe("block");
  });

  it("warns on an open outline", () => {
    const metrics = makeMetrics({ board: { outlineClosed: false } });
    const findings = evaluate(metrics, makeProfile());
    const outline = findings.find((f) => f.id === "size.outlineClosed");
    expect(outline?.severity).toBe("warn");
  });
});

describe("evaluate — layers", () => {
  it("blocks when copper layer count exceeds the machine maximum", () => {
    const metrics = makeMetrics({ layers: { copperLayerCount: 3 } });
    const findings = evaluate(metrics, makeProfile({ maxCopperLayers: 2 }));
    const count = findings.find((f) => f.id === "layers.count");
    expect(count?.severity).toBe("block");
  });

  it("blocks inner copper layers when the machine cannot make them", () => {
    const metrics = makeMetrics({ layers: { innerCopperCount: 1 } });
    const findings = evaluate(metrics, makeProfile({ allowInnerLayers: false }));
    const inner = findings.find((f) => f.id === "layers.inner");
    expect(inner?.severity).toBe("block");
  });

  it("blocks a double-sided design on a single-sided panel", () => {
    const metrics = makeMetrics({
      layers: { copperTop: true, copperBottom: true, copperLayerCount: 2 },
    });
    const stackup = {
      copper_weight_oz: 1,
      substrate_thickness_mm: 1.6,
      double_sided: false,
    };
    const findings = evaluate(metrics, makeProfile(), null, stackup);
    const ds = findings.find((f) => f.id === "layers.doubleSided");
    expect(ds?.severity).toBe("block");
  });

  it("does not block double-sided copper when no stackup is set (treated as double-sided)", () => {
    const metrics = makeMetrics({
      layers: { copperTop: true, copperBottom: true, copperLayerCount: 2 },
    });
    const findings = evaluate(metrics, makeProfile());
    expect(findings.find((f) => f.id === "layers.doubleSided")).toBeUndefined();
  });
});

describe("evaluate — thin trace", () => {
  it("blocks a routed trace narrower than the minimum width", () => {
    const metrics = makeMetrics({
      geo: {
        thinTraceConductors: [{ a: [0, 0], b: [1, 0], v: 0.12, side: "top" }],
        traceHotspots: [{ a: [0, 0], b: [1, 0], v: 0.12, side: "top" }],
      },
    });
    const findings = evaluate(metrics, makeProfile());
    const thin = findings.find((f) => f.id === "copper.thinTrace.top");
    expect(thin?.severity).toBe("block");
  });

  it("warns on a marginal trace within the tolerance band but at/above the minimum", () => {
    const metrics = makeMetrics({
      geo: {
        thinTraceConductors: [{ a: [0, 0], b: [1, 0], v: 0.16, side: "top" }],
        traceHotspots: [{ a: [0, 0], b: [1, 0], v: 0.16, side: "top" }],
      },
    });
    const findings = evaluate(metrics, makeProfile());
    const thin = findings.find((f) => f.id === "copper.thinTrace.top");
    expect(thin?.severity).toBe("warn");
  });
});

describe("overallVerdict", () => {
  const sev = (s: Finding["severity"]): Finding => ({ severity: s }) as Finding;

  it("blocks when any finding is a blocker", () => {
    expect(overallVerdict([sev("block"), sev("warn"), sev("ok")])).toBe("block");
  });

  it("warns when the worst finding is a warning", () => {
    expect(overallVerdict([sev("warn"), sev("ok")])).toBe("warn");
  });

  it("does not escalate on info-only findings", () => {
    expect(overallVerdict([sev("info"), sev("ok")])).toBe("ok");
  });

  it("is ok for an empty finding list", () => {
    expect(overallVerdict([])).toBe("ok");
  });
});

describe("problemTypeOf", () => {
  it("maps copper finding ids to distinct types (not all lumped as 'copper')", () => {
    expect(problemTypeOf("copper.minSpace")).toBe("clearance");
    expect(problemTypeOf("copper.thinTrace.top")).toBe("width");
    expect(problemTypeOf("copper.thinTrace.bottom")).toBe("width");
    expect(problemTypeOf("copper.regionNeck")).toBe("neck");
    expect(problemTypeOf("copper.annular")).toBe("annular");
  });

  it("maps drill/via/mask/silk families by prefix", () => {
    expect(problemTypeOf("drill.minHole")).toBe("drill");
    expect(problemTypeOf("drill.bitSnap")).toBe("drill");
    expect(problemTypeOf("via.plating")).toBe("via");
    expect(problemTypeOf("mask.dam")).toBe("mask");
    expect(problemTypeOf("silk.line.top")).toBe("silk");
  });

  it("returns null for findings without preview hotspots (size/layers)", () => {
    expect(problemTypeOf("size.fits")).toBeNull();
    expect(problemTypeOf("layers.count")).toBeNull();
    expect(problemTypeOf("layers.doubleSided")).toBeNull();
  });

  it("every mappable type is listed in PROBLEM_TYPE_ORDER", () => {
    for (const id of ["copper.minSpace", "copper.thinTrace.top", "copper.regionNeck", "copper.annular", "drill.minHole", "via.plating", "mask.dam", "silk.line.top"]) {
      const t = problemTypeOf(id);
      expect(t).not.toBeNull();
      expect(PROBLEM_TYPE_ORDER).toContain(t!);
    }
  });
});

describe("evaluate — clearance & width", () => {
  it("blocks on a copper clearance below the minimum spacing", () => {
    const metrics = makeMetrics({
      geo: { clearanceHotspots: [{ a: [0, 0], b: [0.1, 0], v: 0.1, side: "both" }] },
    });
    const findings = evaluate(metrics, makeProfile());
    const space = findings.find((f) => f.id === "copper.minSpace");
    expect(space?.severity).toBe("block");
  });

  it("ignores sub-artefact clearance slivers below ignoreBelowMm", () => {
    const metrics = makeMetrics({
      geo: { clearanceHotspots: [{ a: [0, 0], b: [0.02, 0], v: 0.02, side: "both" }] },
    });
    const findings = evaluate(metrics, makeProfile());
    expect(findings.find((f) => f.id === "copper.minSpace")).toBeUndefined();
  });

  it("warns on a copper region neck below the minimum trace width", () => {
    const metrics = makeMetrics({
      geo: { copperWidthHotspots: [{ a: [0, 0], b: [0.1, 0], v: 0.1, side: "top" }] },
    });
    const findings = evaluate(metrics, makeProfile());
    const neck = findings.find((f) => f.id === "copper.regionNeck");
    expect(neck?.severity).toBe("warn");
  });
});

describe("evaluate — drill", () => {
  it("blocks a minimum hole smaller than the machine can drill", () => {
    const metrics = makeMetrics({ drill: { minHoleMm: 0.2 } });
    const findings = evaluate(metrics, makeProfile());
    const hole = findings.find((f) => f.id === "drill.minHole");
    expect(hole?.severity).toBe("block");
  });

  it("accepts a minimum hole at or above the machine limit", () => {
    const metrics = makeMetrics({ drill: { minHoleMm: 0.5 } });
    const findings = evaluate(metrics, makeProfile());
    const hole = findings.find((f) => f.id === "drill.minHole");
    expect(hole?.severity).toBe("ok");
  });

  it("warns on a tool diameter that snaps to no available bit", () => {
    const metrics = makeMetrics({ drill: { uniqueToolDiametersMm: [0.7] } });
    // Pass the available bit set as the 5th arg; 0.7 is not in [0.3, 0.6] → bitSnap fires.
    const findings = evaluate(metrics, makeProfile(), null, null, [0.3, 0.6]);
    const snap = findings.find((f) => f.id === "drill.bitSnap");
    expect(snap?.severity).toBe("warn");
  });

  it("skips bit-snap when no drill bits are configured (empty tool library)", () => {
    const metrics = makeMetrics({ drill: { uniqueToolDiametersMm: [0.7] } });
    // Default 5th arg = [] → bit-snap check is skipped entirely.
    const findings = evaluate(metrics, makeProfile());
    expect(findings.find((f) => f.id === "drill.bitSnap")).toBeUndefined();
  });

  it("passes bit-snap when the diameter matches a configured bit within tolerance", () => {
    const metrics = makeMetrics({ drill: { uniqueToolDiametersMm: [0.8] } });
    // 0.8 snaps to the 0.8 bit (tolerance 0.05) → no bitSnap finding.
    const findings = evaluate(metrics, makeProfile(), null, null, [0.3, 0.8, 1.2]);
    expect(findings.find((f) => f.id === "drill.bitSnap")).toBeUndefined();
  });

  it("reports slots as an ok informational row", () => {
    const metrics = makeMetrics({ geo: { slotCount: 2, minSlotWidthMm: 1.0 } });
    const findings = evaluate(metrics, makeProfile());
    const slots = findings.find((f) => f.id === "drill.slots");
    expect(slots?.severity).toBe("ok");
  });
});

describe("evaluate — via plating", () => {
  it("warns when at least one via-sized hole needs plating", () => {
    const metrics = makeMetrics({ drill: { diameterHistogram: [[0.5, 3]] } });
    const findings = evaluate(metrics, makeProfile());
    const via = findings.find((f) => f.id === "via.plating");
    expect(via?.severity).toBe("warn");
  });

  it("blocks when via-sized holes reach the block threshold", () => {
    const metrics = makeMetrics({ drill: { diameterHistogram: [[0.5, 200]] } });
    const findings = evaluate(metrics, makeProfile());
    const via = findings.find((f) => f.id === "via.plating");
    expect(via?.severity).toBe("block");
  });

  it("is ok when all holes are larger than the via threshold", () => {
    const metrics = makeMetrics({ drill: { diameterHistogram: [[0.8, 5]] } });
    const findings = evaluate(metrics, makeProfile());
    const via = findings.find((f) => f.id === "via.plating");
    expect(via?.severity).toBe("ok");
  });

  it("emits no via finding when plating is available", () => {
    const metrics = makeMetrics({ drill: { diameterHistogram: [[0.5, 3]] } });
    const findings = evaluate(metrics, makeProfile({ viaPlatingAvailable: true }));
    expect(findings.find((f) => f.id === "via.plating")).toBeUndefined();
  });
});

describe("evaluate — annular ring", () => {
  it("blocks when a pad has no annular ring (≤ 0)", () => {
    const metrics = makeMetrics({ geo: { minAnnularMm: -0.01 } });
    const findings = evaluate(metrics, makeProfile());
    const ann = findings.find((f) => f.id === "copper.annular");
    expect(ann?.severity).toBe("block");
  });

  it("warns on a narrow annular ring below the minimum", () => {
    const metrics = makeMetrics({ geo: { minAnnularMm: 0.1 } });
    const findings = evaluate(metrics, makeProfile());
    const ann = findings.find((f) => f.id === "copper.annular");
    expect(ann?.severity).toBe("warn");
  });

  it("accepts an annular ring at or above the minimum", () => {
    const metrics = makeMetrics({ geo: { minAnnularMm: 0.2 } });
    const findings = evaluate(metrics, makeProfile());
    const ann = findings.find((f) => f.id === "copper.annular");
    expect(ann?.severity).toBe("ok");
  });
});

describe("evaluate — mask, silk & overshoot", () => {
  it("reports a mask dam violation as info", () => {
    const metrics = makeMetrics({
      geo: { maskDamHotspots: [{ a: [0, 0], b: [0.07, 0], v: 0.07, side: "top" }] },
    });
    const findings = evaluate(metrics, makeProfile());
    const mask = findings.find((f) => f.id === "mask.dam");
    expect(mask?.severity).toBe("info");
  });

  it("reports a thin silk line as info", () => {
    const metrics = makeMetrics({
      geo: { silkHotspots: [{ a: [0, 0], b: [0.1, 0], v: 0.1, side: "top" }] },
    });
    const findings = evaluate(metrics, makeProfile());
    const silk = findings.find((f) => f.id === "silk.line.top");
    expect(silk?.severity).toBe("info");
  });

  it("does not escalate the verdict for mask/silk info findings only", () => {
    const metrics = makeMetrics({
      geo: {
        maskDamHotspots: [{ a: [0, 0], b: [0.07, 0], v: 0.07, side: "top" }],
        silkHotspots: [{ a: [0, 0], b: [0.1, 0], v: 0.1, side: "top" }],
      },
    });
    const findings = evaluate(metrics, makeProfile());
    expect(overallVerdict(findings)).toBe("ok");
  });

  it("warns when a layer overshoots the board edge beyond the limit", () => {
    const metrics = makeMetrics({
      geo: {
        layerOvershootMm: 0.3,
        overshootHotspots: [{ a: [0, 0], b: [0.3, 0], v: 0.3, side: "top" }],
      },
    });
    const findings = evaluate(metrics, makeProfile());
    const over = findings.find((f) => f.id === "size.overshoot");
    expect(over?.severity).toBe("warn");
  });
});

describe("clusterBoxes", () => {
  /** Reference all-pairs implementation (the pre-grid original) — the grid
   *  version must reproduce its output exactly. */
  const naiveClusterBoxes = (hs: GeoHotspot[], radius: number): GeoHotspot[] => {
    const out: GeoHotspot[] = [];
    const bySide = new Map<string, GeoHotspot[]>();
    for (const h of hs) {
      const arr = bySide.get(h.side) ?? [];
      arr.push(h);
      bySide.set(h.side, arr);
    }
    for (const [side, group] of bySide) {
      const n = group.length;
      const mids = group.map((h) => [(h.a[0] + h.b[0]) / 2, (h.a[1] + h.b[1]) / 2]);
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
  };

  /** Order-independent canonical form for comparing cluster sets. */
  const canon = (cs: GeoHotspot[]) =>
    [...cs].sort((x, y) =>
      x.side.localeCompare(y.side) || x.a[0] - y.a[0] || x.a[1] - y.a[1] || x.b[0] - y.b[0] || x.b[1] - y.b[1] || x.v - y.v,
    );

  const hot = (x: number, y: number, v = 0.1, side: GeoHotspot["side"] = "top"): GeoHotspot => ({
    a: [x, y],
    b: [x + 0.5, y],
    v,
    side,
  });

  /** Deterministic PRNG (mulberry32) for the randomized equivalence case. */
  const mulberry32 = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it("returns no clusters for an empty input", () => {
    expect(clusterBoxes([], 4)).toEqual([]);
  });

  it("wraps a single hotspot in its own box with its value", () => {
    expect(clusterBoxes([hot(3, 7, 0.08)], 4)).toEqual([
      { a: [3, 7], b: [3.5, 7], v: 0.08, side: "top" },
    ]);
  });

  it("does not merge midpoints exactly `radius` apart (strict <)", () => {
    // Midpoints at x=0.25 and x=4.25 → distance exactly 4.
    const clusters = clusterBoxes([hot(0, 0), hot(4, 0)], 4);
    expect(clusters).toHaveLength(2);
  });

  it("chains a row of strokes across many grid cells into one cluster", () => {
    // 20 strokes 3.9 mm apart: each pair is under the 4 mm radius but the row
    // spans ~19 cells — transitivity must survive the 3×3 neighbourhood scan.
    const row = Array.from({ length: 20 }, (_, i) => hot(i * 3.9, 0, 0.1 + i * 0.001));
    const clusters = clusterBoxes(row, 4);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].v).toBeCloseTo(0.1, 10);
    expect(clusters[0].a[0]).toBe(0);
    expect(clusters[0].b[0]).toBeCloseTo(19 * 3.9 + 0.5, 10);
  });

  it("never merges hotspots from different sides", () => {
    const clusters = clusterBoxes([hot(0, 0, 0.1, "top"), hot(0, 0, 0.1, "bottom")], 4);
    expect(clusters).toHaveLength(2);
    expect(new Set(clusters.map((c) => c.side))).toEqual(new Set(["top", "bottom"]));
  });

  it("takes the worst (thinnest) stroke as the cluster value", () => {
    const clusters = clusterBoxes([hot(0, 0, 0.12), hot(1, 0, 0.05), hot(2, 0, 0.09)], 4);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].v).toBe(0.05);
  });

  it("matches the all-pairs reference on a sparse grid layout", () => {
    const hs = Array.from({ length: 200 }, (_, i) => hot((i % 20) * 6, Math.floor(i / 20) * 6));
    expect(canon(clusterBoxes(hs, 4))).toEqual(canon(naiveClusterBoxes(hs, 4)));
  });

  it("matches the all-pairs reference on a dense single-cell blob", () => {
    const rnd = mulberry32(1);
    const hs = Array.from({ length: 300 }, () => hot(rnd() * 3, rnd() * 3, 0.05 + rnd() * 0.1));
    expect(canon(clusterBoxes(hs, 4))).toEqual(canon(naiveClusterBoxes(hs, 4)));
  });

  it("matches the all-pairs reference on random mixed-side scatters", () => {
    for (const seed of [2, 3, 4, 5]) {
      const rnd = mulberry32(seed);
      const hs = Array.from({ length: 500 }, () =>
        hot(rnd() * 80 - 40, rnd() * 60 - 30, 0.05 + rnd() * 0.1, rnd() < 0.5 ? "top" : "bottom"),
      );
      expect(canon(clusterBoxes(hs, 4))).toEqual(canon(naiveClusterBoxes(hs, 4)));
    }
  });
});
