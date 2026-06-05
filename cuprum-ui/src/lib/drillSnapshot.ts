import type { DrillSnapshot, Manifest } from "@/lib/api";
import type { CncProfile } from "@/lib/cncProfile";
import type { Tool } from "@/lib/toolLibrary";

/** Build the snapshot pushed from the main window to the drill-preview window.
 *  Carries the project data needed to reconstruct the drill plan PLUS the shop
 *  settings (CNC profile, tools, DFM thresholds), so the drill window — which
 *  has its own persisted store that only rehydrates on load — reflects profile
 *  and tool edits live, without a restart. */
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
