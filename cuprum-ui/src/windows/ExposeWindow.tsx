import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { api, type ExposeSnapshot } from "@/lib/api";
import { useSnapshotSubscription } from "@/hooks/useTauriListeners";
import { useShowWindowWhenReady } from "@/hooks/useShowWindowWhenReady";
import { ExposeOperationEditor } from "@/components/operations/ExposeOperationEditor";

/** Root of the separate UV-exposure-operation window (label `expose`). Receives
 *  the project as a pushed snapshot from the main window and renders the full
 *  exposure editor (preview, params, run/progress/stop). */
export function ExposeWindow() {
  const { t } = useTranslation("expose");

  // Subscribe to project snapshots, announcing readiness only after the listener
  // is live (so the main window's reply can't arrive before it and be dropped).
  const snap = useSnapshotSubscription<ExposeSnapshot>(
    api.onExposeSnapshot,
    api.emitExposeReady,
  );

  // Window is created hidden; reveal it once the first snapshot has rendered.
  useShowWindowWhenReady(snap !== null);

  useEffect(() => {
    getCurrentWindow().setTitle(t("window.title")).catch(() => {});
  }, [t]);

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#0a0c10]">
      {snap ? (
        <ExposeOperationEditor snapshot={snap} />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-slate-500">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      )}
    </div>
  );
}
