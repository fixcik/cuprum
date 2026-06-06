import { describe, it, expect } from "vitest";
import { estimateDrill } from "@/lib/drillEstimate";
import type { DrillRoute } from "@/lib/drillRoute";
import type { Tool } from "@/lib/toolLibrary";
import type { CncProfile } from "@/lib/cncProfile";
import { DEFAULT_CNC_PROFILE } from "@/lib/cncProfile";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** 3×3 grid of holes at 10 mm spacing, one group, known travel distance. */
function makeRoute(extraGroup = false): DrillRoute {
  // 9 holes: (0,0),(10,0),(20,0),(0,10),(10,10),(20,10),(0,20),(10,20),(20,20)
  const holes = [
    { xMm: 0, yMm: 0 },
    { xMm: 10, yMm: 0 },
    { xMm: 20, yMm: 0 },
    { xMm: 0, yMm: 10 },
    { xMm: 10, yMm: 10 },
    { xMm: 20, yMm: 10 },
    { xMm: 0, yMm: 20 },
    { xMm: 10, yMm: 20 },
    { xMm: 20, yMm: 20 },
  ];

  // pathPoints in a simple left-to-right, top-to-bottom scan order.
  // Travel for this ordering: 8 segments of 10 mm each + 2 diagonal 10√2 mm
  // (row breaks 0→10→20 then jump back) — but we just use exact pathPoints
  // so the test can verify the formula, not the ordering algorithm.
  const pathPoints = [...holes];

  const groups: DrillRoute["groups"] = [
    {
      diameterMm: 0.8,
      class: "pth",
      toolId: "tool-1",
      orderedHoles: holes,
    },
  ];

  if (extraGroup) {
    const extra = [{ xMm: 5, yMm: 5 }];
    groups.push({
      diameterMm: 1.2,
      class: "npth",
      toolId: "tool-2",
      orderedHoles: extra,
    });
    pathPoints.push(...extra);
  }

  return {
    groups,
    pathPoints,
    totalHoles: holes.length + (extraGroup ? 1 : 0),
    toolCount: extraGroup ? 2 : 1,
  };
}

const TOOLS: Tool[] = [
  {
    id: "tool-1",
    name: "Drill 0.8",
    kind: "drill",
    diameterMm: 0.8,
    material: "carbide",
    recommendedRpm: 9000,
    recommendedFeedMmMin: 100,
    recommendedPlungeMmMin: 60,
  },
  {
    id: "tool-2",
    name: "Drill 1.2",
    kind: "drill",
    diameterMm: 1.2,
    material: "carbide",
    recommendedRpm: 9000,
    recommendedFeedMmMin: 100,
    recommendedPlungeMmMin: 60,
  },
];

const PROFILE: CncProfile = { ...DEFAULT_CNC_PROFILE, jogFeedMmMin: 500 };

const SUBSTRATE_MM = 1.6;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("estimateDrill", () => {
  it("travelMm: sums Euclidean distances over pathPoints", () => {
    const route = makeRoute();
    // Simple scan: (0,0)→(10,0)→…→(20,20)
    // Compute expected: 8 horizontal/vertical 10mm segments + 0 diagonals for
    // this fixture (all in a row, left-to-right then snake).
    let expected = 0;
    const pts = route.pathPoints;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].xMm - pts[i - 1].xMm;
      const dy = pts[i].yMm - pts[i - 1].yMm;
      expected += Math.sqrt(dx * dx + dy * dy);
    }

    const result = estimateDrill(route, TOOLS, PROFILE, SUBSTRATE_MM);
    expect(result.travelMm).toBeCloseTo(expected, 5);
  });

  it("toolChanges: counts groups with non-null toolId", () => {
    const r1 = makeRoute(false);
    expect(estimateDrill(r1, TOOLS, PROFILE, SUBSTRATE_MM).toolChanges).toBe(1);

    const r2 = makeRoute(true);
    expect(estimateDrill(r2, TOOLS, PROFILE, SUBSTRATE_MM).toolChanges).toBe(2);
  });

  it("timeSec > 0", () => {
    const result = estimateDrill(makeRoute(), TOOLS, PROFILE, SUBSTRATE_MM);
    expect(result.timeSec).toBeGreaterThan(0);
  });

  it("timeSec is monotonically larger with more holes (extra group adds holes + tool change)", () => {
    const small = estimateDrill(makeRoute(false), TOOLS, PROFILE, SUBSTRATE_MM);
    const big = estimateDrill(makeRoute(true), TOOLS, PROFILE, SUBSTRATE_MM);
    expect(big.timeSec).toBeGreaterThan(small.timeSec);
  });

  it("timeSec is integer (Math.round applied)", () => {
    const result = estimateDrill(makeRoute(), TOOLS, PROFILE, SUBSTRATE_MM);
    expect(result.timeSec).toBe(Math.round(result.timeSec));
  });
});
