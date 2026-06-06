import { describe, expect, it } from "vitest";
import { nearestBit } from "@/lib/drillBitOverride";
import type { Tool } from "@/lib/toolLibrary";

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

describe("nearestBit", () => {
  it("returns the closest drill tool by diameter", () => {
    const tools: Tool[] = [drill("tool-1", 0.8), drill("tool-2", 1.2), drill("tool-3", 0.5)];
    const result = nearestBit(0.85, tools);
    expect(result?.id).toBe("tool-1"); // 0.8 is closest to 0.85
  });

  it("returns null for an empty tool list", () => {
    expect(nearestBit(1.0, [])).toBeNull();
  });

  it("returns null when no drill-kind tools exist", () => {
    const tools: Tool[] = [
      { ...drill("tool-1", 1.0), kind: "endmill" },
      { ...drill("tool-2", 1.0), kind: "vbit", angleDeg: 30 },
    ];
    expect(nearestBit(1.0, tools)).toBeNull();
  });

  it("ties: first tool in array wins", () => {
    const tools: Tool[] = [drill("tool-a", 0.5), drill("tool-b", 1.5)];
    // 1.0 is equidistant (0.5) from both; tool-a comes first
    const result = nearestBit(1.0, tools);
    expect(result?.id).toBe("tool-a");
  });

  it("exact match wins", () => {
    const tools: Tool[] = [drill("tool-1", 0.3), drill("tool-2", 0.8), drill("tool-3", 1.2)];
    expect(nearestBit(0.8, tools)?.id).toBe("tool-2");
  });

  it("skips non-drill tools", () => {
    const tools: Tool[] = [
      { ...drill("tool-1", 0.4), kind: "endmill" },
      drill("tool-2", 1.5),
    ];
    expect(nearestBit(0.4, tools)?.id).toBe("tool-2");
  });
});
