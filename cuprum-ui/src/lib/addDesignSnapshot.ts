import type { AddDesignSnapshot, Manifest } from "@/lib/api";

/** Build the snapshot pushed from the main window to the add-design window.
 *  Shared by the reactive bridge (re-emits on manifest change, no preselect) and
 *  the store's openAddDesignForDesign (one-off direct push carrying a preselect
 *  to an already-open window that won't re-emit `ready`). */
export function buildAddDesignSnapshot(args: {
  workingDir: string | null;
  currentPath: string | null;
  manifest: Manifest | null;
  preselectDesignId: string | null;
}): AddDesignSnapshot {
  return {
    workingDir: args.workingDir,
    currentPath: args.currentPath,
    designs: args.manifest?.designs ?? [],
    panel: {
      widthMm: args.manifest?.panel?.width_mm ?? 100,
      heightMm: args.manifest?.panel?.height_mm ?? 100,
    },
    preselectDesignId: args.preselectDesignId,
  };
}
