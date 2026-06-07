import type { DrillSnapshot, Manifest } from "@/lib/api";
import type { CncProfile } from "@/lib/cncProfile";
import type { Tool } from "@/lib/toolLibrary";

/** Bundle the project data needed to reconstruct the drill plan PLUS the shop
 *  settings (CNC profile, tools, DFM thresholds). Built from the main-window stores
 *  by useDrillScreenData (in the drill bridge) and pushed over IPC to the separate
 *  drill window, which renders the drill operation editor from it. */
export function buildDrillSnapshot(args: {
  workingDir: string | null;
  currentPath: string | null;
  manifest: Manifest | null;
  placedSizes: Record<string, { w: number; h: number }>;
  cncProfile: CncProfile;
  tools: Tool[];
  viaMaxDiameterMm: number;
  drillBitToleranceMm: number;
}): DrillSnapshot {
  return {
    workingDir: args.workingDir,
    currentPath: args.currentPath,
    manifest: args.manifest,
    placedSizes: args.placedSizes,
    cncProfile: args.cncProfile,
    tools: args.tools,
    viaMaxDiameterMm: args.viaMaxDiameterMm,
    drillBitToleranceMm: args.drillBitToleranceMm,
  };
}
