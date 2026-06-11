import type { MillSnapshot, MillDefaults, Manifest, DatumCornerDto } from "@/lib/api";
import type { CncProfile } from "@/lib/cncProfile";
import type { Tool } from "@/lib/toolLibrary";

/** Bundle the project data needed to plan an isolation-milling run PLUS the shop
 *  settings (CNC profile, tools, cut defaults, datum). Built from the main-window
 *  stores by useMillScreenData (in the mill bridge) and pushed over IPC to the
 *  separate mill window, which renders the mill operation editor from it. Mirrors
 *  buildDrillSnapshot. */
export function buildMillSnapshot(args: {
  workingDir: string | null;
  currentPath: string | null;
  manifest: Manifest | null;
  placedSizes: Record<string, { w: number; h: number }>;
  cncProfile: CncProfile;
  tools: Tool[];
  millDefaults: MillDefaults;
  millDatumCorner: DatumCornerDto;
}): MillSnapshot {
  return {
    workingDir: args.workingDir,
    currentPath: args.currentPath,
    manifest: args.manifest,
    placedSizes: args.placedSizes,
    cncProfile: args.cncProfile,
    tools: args.tools,
    millDefaults: args.millDefaults,
    millDatumCorner: args.millDatumCorner,
  };
}
