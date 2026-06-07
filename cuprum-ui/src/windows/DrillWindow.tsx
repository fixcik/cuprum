import { useEffect, useMemo, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { api, type DrillSnapshot } from "@/lib/api";
import { DrillOperationEditor } from "@/components/operations/DrillOperationEditor";
import { useSnapshotSubscription } from "@/hooks/useTauriListeners";
import { useShowWindowWhenReady } from "@/hooks/useShowWindowWhenReady";
import { useDrillMachineFollower } from "@/hooks/useDrillMachineFollower";
import {
  MachineActionsProvider,
  mainMachineActions,
} from "@/components/machine/MachineActionsContext";

/** Phases in which a run is live on the machine — closing the window then needs a
 *  confirm (the run keeps going on the backend regardless of the window). */
const INACTIVE_PHASES = new Set(["idle", "done", "error"]);

/** Root of the separate drilling-operation window (label `drill`). Receives the
 *  project as a pushed snapshot, follows the machine via global broadcasts, and
 *  drives the run by sending commands straight to the backend. */
export function DrillWindow() {
  const { t } = useTranslation("drill");
  // Subscribe to project snapshots, announcing readiness only after the listener
  // is live (so the main window's reply can't land before it and be dropped).
  const snap = useSnapshotSubscription<DrillSnapshot>(api.onDrillSnapshot, api.emitDrillReady);
  // Populate this window's machineStore from the global machine broadcasts.
  useDrillMachineFollower();
  // Window is created hidden; reveal it once the first snapshot has rendered.
  useShowWindowWhenReady(snap !== null);
  // Stable action handlers for the machine controls rendered inside this window
  // (ConnBar in DrillPlanInspector). The drill window can own a connection, so
  // mainMachineActions() is correct here: connect/disconnect go through the store.
  const actions = useMemo(() => mainMachineActions(), []);

  useEffect(() => {
    getCurrentWindow().setTitle(t("window.title")).catch(() => {});
  }, [t]);

  // Guard closing while a run is live: the run keeps streaming to the machine even
  // after the window closes, so confirm intent first. Track the live phase locally
  // (seeded from the backend, updated by run events) so the close handler can decide
  // synchronously whether to prompt.
  const runActiveRef = useRef(false);
  useEffect(() => {
    api.drillRun
      .status()
      .then((st) => {
        runActiveRef.current = st.active && !INACTIVE_PHASES.has(st.phase);
      })
      .catch(() => {});
    const subState = api.drillRun.onState((phase) => {
      runActiveRef.current = !INACTIVE_PHASES.has(phase);
    });
    const subDone = api.drillRun.onDone(() => {
      runActiveRef.current = false;
    });
    const subError = api.drillRun.onError(() => {
      runActiveRef.current = false;
    });
    const win = getCurrentWindow();
    const closeReq = win.onCloseRequested(async (event) => {
      if (!runActiveRef.current) return; // no live run — let it close
      event.preventDefault();
      const ok = await confirm(t("window.closeDuringRun"), { kind: "warning" });
      if (ok) await win.destroy();
    });
    return () => {
      void subState.then((un) => un());
      void subDone.then((un) => un());
      void subError.then((un) => un());
      void closeReq.then((un) => un());
    };
  }, [t]);

  return (
    <MachineActionsProvider value={actions}>
      <div className="h-screen w-screen overflow-hidden bg-[#0a0c10]">
        {snap ? (
          <DrillOperationEditor snapshot={snap} />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-slate-500">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        )}
      </div>
    </MachineActionsProvider>
  );
}
