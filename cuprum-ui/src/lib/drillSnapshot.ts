import type { DrillSnapshot, Manifest } from "@/lib/api";
import type { CncProfile } from "@/lib/cncProfile";
import type { Tool } from "@/lib/toolLibrary";

/** Bundle the project data needed to reconstruct the drill plan PLUS the shop
 *  settings (CNC profile, tools, DFM thresholds). Built inline from the stores by
 *  useDrillScreenData and consumed by the drill operation editor. (Historically
 *  this was pushed over IPC to a separate drill window; the screen is now inline.) */
export function buildDrillSnapshot(args: {
  workingDir: string | null;
  manifest: Manifest | null;
  placedSizes: Record<string, { w: number; h: number }>;
  cncProfile: CncProfile;
  tools: Tool[];
  viaMaxDiameterMm: number;
  drillBitToleranceMm: number;
}): DrillSnapshot {
  return {
    workingDir: args.workingDir,
    manifest: args.manifest,
    placedSizes: args.placedSizes,
    cncProfile: args.cncProfile,
    tools: args.tools,
    viaMaxDiameterMm: args.viaMaxDiameterMm,
    drillBitToleranceMm: args.drillBitToleranceMm,
  };
}
