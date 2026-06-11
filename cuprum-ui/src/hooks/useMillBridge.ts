import { useEffect, useRef } from "react";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";
import { useMillScreenData } from "@/hooks/useMillScreenData";
import { useBridgeListeners } from "@/hooks/useTauriListeners";

/** Main-window side of the mill bridge. Mount once in App. The mill window is a
 *  remote control: it gets the project as a snapshot and follows the machine via the
 *  global `machine://status` broadcast (it does NOT take the telemetry Channel), so
 *  both windows stay live. The one machine field not in that broadcast — the
 *  JS-derived `homed` flag (plus the soft-limit settings) — is relayed via the shared
 *  `machine://derived` event (already emitted by useDrillBridge). Phase 4a is
 *  preview-only — no run intents flow back from the window yet. */
export function useMillBridge() {
  // Same snapshot the editor uses — built from the main-window stores.
  const snap = useMillScreenData();

  // Ref so the mount-time ready listener pushes the latest snapshot without
  // re-binding on every change.
  const snapRef = useRef(snap);
  snapRef.current = snap;

  // Push the project snapshot whenever it changes.
  useEffect(() => {
    void api.emitMillSnapshot(snap);
  }, [snap]);

  useBridgeListeners(() => [
    api.onMillReady(() => {
      // Seed a freshly-opened window with the current snapshot + derived state.
      void api.emitMillSnapshot(snapRef.current);
      const m = useMachine.getState();
      void api.emitMachineDerived({
        homed: m.homed,
        softLimitsEnabled: m.softLimitsEnabled,
        maxTravelMm: m.maxTravelMm,
      });
    }),
  ]);
}
