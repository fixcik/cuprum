import { useMemo } from "react";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";
import { buildMillSnapshot } from "@/lib/millSnapshot";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";
import type { MillSnapshot } from "@/lib/api";

/** Build a MillSnapshot directly from the main-window stores, bypassing IPC.
 *  Memoized over individual store slices so identity changes only when an input
 *  changes — useMillPlan depends on snapshot object identity to avoid reruns. */
export function useMillScreenData(): MillSnapshot {
  const workingDir = useShell((s) => s.workingDir);
  const currentPath = useShell((s) => s.currentPath);
  const manifest = useShell((s) => s.currentManifest);
  const placedSizes = usePlacedBoardSizes();
  const cncProfile = useSettings((s) => s.cncProfile);
  const tools = useSettings((s) => s.tools);
  const millDefaults = useSettings((s) => s.millDefaults);
  const millDatumCorner = useSettings((s) => s.millDatumCorner);

  return useMemo(
    () =>
      buildMillSnapshot({
        workingDir,
        currentPath,
        manifest,
        placedSizes,
        cncProfile,
        tools,
        millDefaults,
        millDatumCorner,
      }),
    [workingDir, currentPath, manifest, placedSizes, cncProfile, tools, millDefaults, millDatumCorner],
  );
}
