import { describe, it, expect } from "vitest";
import { evaluate, overallVerdict, minAbove, problemTypeOf, PROBLEM_TYPE_ORDER } from "@/lib/feasibility";
import type { Finding } from "@/lib/feasibility";
import type { BoardMetrics } from "@/lib/api";
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
    board: { widthMm: 50, heightMm: 40, outlineClosed: true, cutoutCount: 0, hasEdgeLayer: true },
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
  it("ok when the board fits the machine work area (no panel)", () => {
    const findings = evaluate(makeMetrics(), makeProfile());
    const size = findings.find((f) => f.id === "size.fits");
    expect(size?.severity).toBe("ok");
  });

  it("warns when it fits only rotated and rotation is allowed", () => {
    const metrics = makeMetrics({ board: { widthMm: 90, heightMm: 150 } });
    const findings = evaluate(metrics, makeProfile({ allowRotateToFit: true }));
    const size = findings.find((f) => f.id === "size.fits");
    expect(size?.severity).toBe("warn");
  });

  it("blocks when the board does not fit in any orientation", () => {
    const metrics = makeMetrics({ board: { widthMm: 250, heightMm: 250 } });
    const findings = evaluate(metrics, makeProfile());
    const size = findings.find((f) => f.id === "size.fits");
    expect(size?.severity).toBe("block");
  });

  it("checks against the panel dimensions when a panel is configured", () => {
    const metrics = makeMetrics({ board: { widthMm: 70, heightMm: 40 } });
    const panel = {
      schema_version: 2,
      width_mm: 60,
      height_mm: 60,
      origin_x_mm: 0,
      origin_y_mm: 0,
      instances: [],
      tooling_holes: [],
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
