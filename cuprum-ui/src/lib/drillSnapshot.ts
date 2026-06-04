import type { DrillSnapshot, Manifest } from "@/lib/api";

/** Build the snapshot pushed from the main window to the drill-preview window.
 *  Contains only what is needed to reconstruct the drill plan; tool inventory
 *  and capability profile are read from useSettings inside the window. */
export function buildDrillSnapshot(args: {
  workingDir: string | null;
  manifest: Manifest | null;
  placedSizes: Record<string, { w: number; h: number }>;
}): DrillSnapshot {
  return {
    workingDir: args.workingDir,
    manifest: args.manifest,
    placedSizes: args.placedSizes,
  };
}
