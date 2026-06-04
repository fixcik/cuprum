/** Shop tool library — drills / end-mills / V-bits with FR4 cutting params.
 *  Global (one shop), persisted in settingsStore. The Drill tools' diameters are
 *  the source of truth for the DFM "bit snap" check (see drillBitsFromTools).
 *  v1 fills the library with drills; EndMill/VBit kinds exist for later milling. */
export type ToolKind = "drill" | "endmill" | "vbit";
export type ToolMaterial = "carbide" | "hss";

export interface Tool {
  /** Stable id ("tool-1", …). */
  id: string;
  name: string;
  kind: ToolKind;
  diameterMm: number;
  material: ToolMaterial;
  recommendedRpm: number;
  recommendedFeedMmMin: number;
  recommendedPlungeMmMin: number;
  /** V-bit tip angle (degrees); only meaningful when kind === "vbit". */
  angleDeg?: number;
}

/** Default drill set — the diameters that used to live in `drillBitSetMm`, as
 *  carbide drills with sane FR4 params (3018-class spindle ≤ 9000 rpm). */
export const DEFAULT_TOOLS: Tool[] = [0.3, 0.4, 0.5, 0.6, 0.8, 1.0, 1.2, 2.0, 3.0].map(
  (d, i) => ({
    id: `tool-${i + 1}`,
    name: `Сверло ${d}`,
    kind: "drill" as ToolKind,
    diameterMm: d,
    material: "carbide" as ToolMaterial,
    recommendedRpm: 9000,
    recommendedFeedMmMin: 100,
    recommendedPlungeMmMin: 60,
  }),
);

/** Next stable id: max existing `tool-N` + 1 (not array length — survives deletions). */
export function nextToolId(tools: Tool[]): string {
  const max = tools.reduce((m, t) => {
    const n = /^tool-(\d+)$/.exec(t.id);
    return n ? Math.max(m, Number(n[1])) : m;
  }, 0);
  return `tool-${max + 1}`;
}

/** A fresh default Drill tool with the next id (used by the "add tool" button). */
export function newDrillTool(tools: Tool[]): Tool {
  return {
    id: nextToolId(tools),
    name: "Сверло",
    kind: "drill",
    diameterMm: 0.8,
    material: "carbide",
    recommendedRpm: 9000,
    recommendedFeedMmMin: 100,
    recommendedPlungeMmMin: 60,
  };
}

/** Available drill diameters (mm) for the DFM bit-snap check — the Drill tools'
 *  diameters, sorted ascending. */
export function drillBitsFromTools(tools: Tool[]): number[] {
  return tools
    .filter((t) => t.kind === "drill")
    .map((t) => t.diameterMm)
    .sort((a, b) => a - b);
}
