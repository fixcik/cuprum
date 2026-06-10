import { useMemo } from "react";
import { useShell } from "@/shellStore";
import { buildExposeSnapshot } from "@/lib/exposeSnapshot";
import type { ExposeSnapshot } from "@/lib/api";

/** Build an ExposeSnapshot directly from the main-window stores, bypassing IPC.
 *  Memoized over individual store slices so identity changes only when an input
 *  changes. The exposure parameters (side/mirror/invert/exposureS/pwm) will be
 *  editable per-project in Phase 4; for now they carry sensible defaults. */
export function useExposeScreenData(): ExposeSnapshot {
  const workingDir = useShell((s) => s.workingDir);
  const currentPath = useShell((s) => s.currentPath);
  const manifest = useShell((s) => s.currentManifest);

  return useMemo(
    () =>
      buildExposeSnapshot({
        workingDir,
        currentPath,
        manifest,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workingDir, currentPath, manifest],
  );
}
