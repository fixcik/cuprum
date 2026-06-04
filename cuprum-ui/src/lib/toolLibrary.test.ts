import { describe, expect, it } from "vitest";
import { drillBitsFromTools, nextToolId, type Tool } from "@/lib/toolLibrary";

const drill = (id: string, d: number): Tool => ({
  id,
  name: `Drill ${d}`,
  kind: "drill",
  diameterMm: d,
  material: "carbide",
  recommendedRpm: 9000,
  recommendedFeedMmMin: 100,
  recommendedPlungeMmMin: 60,
});

describe("drillBitsFromTools", () => {
  it("returns only drill diameters, sorted ascending", () => {
    const tools: Tool[] = [
      drill("tool-1", 0.8),
      { ...drill("tool-2", 1.2), kind: "endmill" },
      drill("tool-3", 0.3),
      { ...drill("tool-4", 60), kind: "vbit", angleDeg: 30 },
    ];
    expect(drillBitsFromTools(tools)).toEqual([0.3, 0.8]);
  });
  it("handles an empty library", () => {
    expect(drillBitsFromTools([])).toEqual([]);
  });
});

describe("nextToolId", () => {
  it("is max existing tool-N + 1, stable across deletions", () => {
    expect(nextToolId([])).toBe("tool-1");
    expect(nextToolId([drill("tool-1", 1), drill("tool-5", 2)])).toBe("tool-6");
  });
});
