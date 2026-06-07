import { useEffect, useRef } from "react";
import { useShell } from "@/shellStore";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";
import { useDrillScreenData } from "@/hooks/useDrillScreenData";
import { useBridgeListeners } from "@/hooks/useTauriListeners";

/** Main-window side of the drill bridge. Mount once in App. The drill window is a
 *  remote control: it gets the project as a snapshot and follows the machine via the
 *  global `machine://status` broadcast (it does NOT take the telemetry Channel), so
 *  both windows stay live. The one machine field not in that broadcast — the
 *  JS-derived `homed` flag — is relayed here. The window sends machine/run commands
 *  directly via invoke; project mutations come back as intents (set-class-override). */
export function useDrillBridge() {
  // Same snapshot the editor used inline — built from the main-window stores.
  const snap = useDrillScreenData();
  const homed = useMachine((s) => s.homed);

  // Ref so the mount-time ready listener pushes the latest snapshot without
  // re-binding on every change.
  const snapRef = useRef(snap);
  snapRef.current = snap;

  // Push the project snapshot whenever it changes.
  useEffect(() => {
    void api.emitDrillSnapshot(snap);
  }, [snap]);

  // Relay the JS-derived homed flag (absent from the backend broadcast).
  useEffect(() => {
    void api.emitMachineDerived({ homed });
  }, [homed]);

  useBridgeListeners(() => [
    api.onDrillReady(() => {
      // Seed a freshly-opened window with the current snapshot + derived flag.
      void api.emitDrillSnapshot(snapRef.current);
      void api.emitMachineDerived({ homed: useMachine.getState().homed });
      // Hand off a pending "repeat run" prefill to the just-opened window (one-shot).
      const pending = useShell.getState().pendingDrillPrefill;
      if (pending) {
        void api.emitDrillPrefill(pending);
        useShell.getState().setPendingDrillPrefill(null);
      }
    }),
    api.onDrillSetClassOverride(({ diameterKey, klass }) =>
      void useShell.getState().setDrillClassOverride(diameterKey, klass),
    ),
  ]);
}
