import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { api, type MillSnapshot } from "@/lib/api";
import { MillOperationEditor } from "@/components/operations/MillOperationEditor";
import { useSnapshotSubscription } from "@/hooks/useTauriListeners";
import { useShowWindowWhenReady } from "@/hooks/useShowWindowWhenReady";
import { useDrillMachineFollower } from "@/hooks/useDrillMachineFollower";

/** Root of the separate isolation-milling window (label `mill`). Receives the
 *  project as a pushed snapshot and follows the machine via global broadcasts. Phase
 *  4a is preview-only — no run lifecycle, so (unlike DrillWindow) there is no
 *  close-during-run guard. */
export function MillWindow() {
  const { t } = useTranslation("mill");
  // Subscribe to project snapshots, announcing readiness only after the listener
  // is live (so the main window's reply can't land before it and be dropped).
  const snap = useSnapshotSubscription<MillSnapshot>(api.onMillSnapshot, api.emitMillReady);
  // Populate this window's machineStore from the global machine broadcasts (shared
  // follower — it does not own the serial Channel, same as the drill window).
  useDrillMachineFollower();
  // Window is created hidden; reveal it once the first snapshot has rendered.
  useShowWindowWhenReady(snap !== null);

  useEffect(() => {
    getCurrentWindow().setTitle(t("window.title")).catch(() => {});
  }, [t]);

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#0a0c10]">
      {snap ? (
        <MillOperationEditor snapshot={snap} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-slate-500">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}
    </div>
  );
}
