import { useEffect } from "react";
import { api } from "@/lib/api";
import { useBridgeListeners } from "@/hooks/useTauriListeners";
import { useDrillRunStore } from "@/drillRunStore";

/** Mount once at the MAIN window root. Keeps `drillRunStore` in sync with the live
 *  drill run via the global `drill-run://*` broadcasts, regardless of which tab or
 *  project is open. `status()` on mount catches a run already in progress (re-attach).
 *  Do NOT mount in the drill window itself. */
export function useDrillRunLiveListeners() {
  // Re-attach: if a run is already live when the window mounts, seed phase/active.
  useEffect(() => {
    void api.drillRun
      .status()
      .then((s) => useDrillRunStore.getState().applyStatus(s))
      .catch(() => {});
  }, []);

  // StrictMode-safe listener lifecycle — see useBridgeListeners.
  useBridgeListeners(() => [
    api.drillRun.onState((phase) => useDrillRunStore.getState().applyState(phase)),
    api.drillRun.onProgress((p) =>
      useDrillRunStore.getState().applyProgress({
        holesCompleted: p.holesCompleted,
        holesTotal: p.holesTotal,
        holeIndex: p.holeIndex,
      }),
    ),
    api.drillRun.onToolChange((p) =>
      useDrillRunStore.getState().applyToolChange({ toolName: p.toolName, diameterMm: p.diameterMm }),
    ),
    api.drillRun.onError(() => useDrillRunStore.getState().reset()),
    api.drillRun.onDone(() => useDrillRunStore.getState().reset()),
  ]);
}
