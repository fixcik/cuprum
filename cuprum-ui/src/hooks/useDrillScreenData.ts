import { useMemo } from "react";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";
import { buildDrillSnapshot } from "@/lib/drillSnapshot";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";
import type { DrillSnapshot } from "@/lib/api";

/** Build a DrillSnapshot directly from the main-window stores, bypassing IPC.
 *  Memoized over individual store slices so identity changes only when an input
 *  changes — useDrillPlan depends on snapshot object identity to avoid reruns. */
export function useDrillScreenData(): DrillSnapshot {
  const workingDir = useShell((s) => s.workingDir);
  const currentPath = useShell((s) => s.currentPath);
  const manifest = useShell((s) => s.currentManifest);
  const placedSizes = usePlacedBoardSizes();
  const cncProfile = useSettings((s) => s.cncProfile);
  const tools = useSettings((s) => s.tools);
  const viaMaxDiameterMm = useSettings((s) => s.profile.viaMaxDiameterMm);
  const drillBitToleranceMm = useSettings((s) => s.profile.drillBitToleranceMm);

  return useMemo(
    () =>
      buildDrillSnapshot({
        workingDir,
        currentPath,
        manifest,
        placedSizes,
        cncProfile,
        tools,
        viaMaxDiameterMm,
        drillBitToleranceMm,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workingDir, currentPath, manifest, placedSizes, cncProfile, tools, viaMaxDiameterMm, drillBitToleranceMm],
  );
}
