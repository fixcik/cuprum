import { useMemo } from "react";
import { useShell } from "@/shellStore";
import { buildExposeSnapshot } from "@/lib/exposeSnapshot";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";
import type { ExposeSnapshot } from "@/lib/api";

/** Build an ExposeSnapshot directly from the main-window stores, bypassing IPC.
 *  Memoized over individual store slices so identity changes only when an input
 *  changes. The exposure parameters (side/mirror/invert/exposureS/pwm) carry
 *  sensible defaults (the editor prefills from the last run / repeat-run). */
export function useExposeScreenData(): ExposeSnapshot {
  const workingDir = useShell((s) => s.workingDir);
  const currentPath = useShell((s) => s.currentPath);
  const manifest = useShell((s) => s.currentManifest);
  // Resolved board extents (mm) per placed design — same source the drill snapshot
  // uses, so the read-only preview footprints match real board sizes.
  const placedSizes = usePlacedBoardSizes();

  return useMemo(
    () =>
      buildExposeSnapshot({
        workingDir,
        currentPath,
        manifest,
        placedSizes,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workingDir, currentPath, manifest, placedSizes],
  );
}
