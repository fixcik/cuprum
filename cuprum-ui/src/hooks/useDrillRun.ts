import { useCallback, useEffect, useReducer, useState } from "react";
import { api } from "@/lib/api";
import type { DrillStep } from "@/lib/api";
import {
  drillRunReducer,
  initialDrillRunState,
  type DrillRunState,
  type DrillRunPhase,
} from "@/lib/drillRunState";

export interface UseDrillRun {
  state: DrillRunState;
  connected: boolean;
  start: (steps: DrillStep[]) => Promise<void>;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  /** Cancel a pending graceful stop while the current hole is still finishing —
   *  returns the run to "running" without restarting. */
  cancelStop: () => void;
  estop: () => void;
  confirmToolChange: () => void;
  /** Mark Z as bound for the current bit (probe or manual touch-off succeeded) —
   *  unlocks "Продолжить"/"Начать". Frontend-only; no machine command here. */
  markZBound: () => void;
  /** Re-open the Z touch-off flow for the current bit (e.g. the bound zero left too
   *  little travel below for the plunge). Frontend-only; no machine command here. */
  markZUnbound: () => void;
  /** Mark the probe circuit as tested for THIS session — the operator touched the
   *  probe to the bit and the pin latched. Persists across tool changes (the check
   *  is once per run). Frontend-only; no machine command here. */
  markProbeChecked: () => void;
  /** Record the machine Z (mm) of a manual touch-off confirm — drives the yellow
   *  "previous Z" mark on the manual Z bar. Frontend-only; no machine command. */
  markManualZ: (zMm: number) => void;
  reset: () => void;
}

export function useDrillRun(): UseDrillRun {
  const [state, dispatch] = useReducer(drillRunReducer, initialDrillRunState);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    api.drillRun.isConnected().then(setConnected).catch(() => {});
    // Re-attach: if a run is already live (window opened/reopened mid-run), reflect
    // its phase immediately. Progress (holesCompleted) fills in from the next event.
    api.drillRun
      .status()
      .then((st) => {
        if (!st.active) return;
        // Mid-tool-change re-attach: rebuild the tool-change card from the snapshot
        // (the one-shot `toolchange` event won't re-fire for a late follower).
        if (
          st.phase === "awaitingToolChange" &&
          st.toolName != null &&
          st.diameterMm != null
        ) {
          dispatch({ type: "toolchange", toolName: st.toolName, diameterMm: st.diameterMm });
        } else {
          dispatch({ type: "state", phase: st.phase as DrillRunPhase });
        }
      })
      .catch(() => {});

    const subState = api.drillRun.onState((phase) =>
      dispatch({ type: "state", phase: phase as DrillRunPhase }),
    );
    const subProgress = api.drillRun.onProgress((p) =>
      dispatch({ type: "progress", holesCompleted: p.holesCompleted, holeIndex: p.holeIndex }),
    );
    const subToolChange = api.drillRun.onToolChange((p) =>
      dispatch({ type: "toolchange", toolName: p.toolName, diameterMm: p.diameterMm }),
    );
    const subError = api.drillRun.onError((message) =>
      dispatch({ type: "error", message }),
    );
    const subDone = api.drillRun.onDone(() => dispatch({ type: "done" }));

    const subConnected = api.machine.onConnected(() => setConnected(true));
    const subDisconnected = api.machine.onDisconnected(() => setConnected(false));

    return () => {
      void subState.then((un) => un());
      void subProgress.then((un) => un());
      void subToolChange.then((un) => un());
      void subError.then((un) => un());
      void subDone.then((un) => un());
      void subConnected.then((un) => un());
      void subDisconnected.then((un) => un());
    };
  }, []);

  const start = useCallback(async (steps: DrillStep[]) => {
    dispatch({ type: "reset" });
    dispatch({
      type: "start",
      holesTotal: steps.filter((s) => s.kind === "hole").length,
    });
    await api.drillRun.start(steps);
  }, []);

  const pause = useCallback(() => {
    void api.drillRun.pause();
  }, []);

  const resume = useCallback(() => {
    void api.drillRun.resume();
  }, []);

  const stop = useCallback(() => {
    void api.drillRun.stop();
  }, []);

  const cancelStop = useCallback(() => {
    void api.drillRun.cancelStop();
  }, []);

  const estop = useCallback(() => {
    void api.drillRun.estop();
  }, []);

  const confirmToolChange = useCallback(() => {
    void api.drillRun.confirmToolChange();
  }, []);

  const markZBound = useCallback(() => {
    dispatch({ type: "zbound" });
  }, []);

  const markZUnbound = useCallback(() => {
    dispatch({ type: "zunbound" });
  }, []);

  const markProbeChecked = useCallback(() => {
    dispatch({ type: "probechecked" });
  }, []);

  const markManualZ = useCallback((zMm: number) => {
    dispatch({ type: "manualz", zMm });
  }, []);

  // Return to idle (PLAN mode) after a finished/error run without starting a new
  // one — e.g. "finish pass". Local state only; no machine command.
  const reset = useCallback(() => {
    dispatch({ type: "reset" });
  }, []);

  return {
    state,
    connected,
    start,
    pause,
    resume,
    stop,
    cancelStop,
    estop,
    confirmToolChange,
    markZBound,
    markZUnbound,
    markProbeChecked,
    markManualZ,
    reset,
  };
}
