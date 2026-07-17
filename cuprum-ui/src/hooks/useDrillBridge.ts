import { useEffect, useRef } from "react";
import { useShell } from "@/shellStore";
import { useMachine } from "@/machineStore";
import { useNavigation } from "@/navigationStore";
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
  // Machine state the backend broadcast doesn't carry but the drill window needs:
  // the JS-derived `homed` flag and the soft-limit settings ($20 / $132) the
  // Z-headroom guard relies on — the drill window never reads `$$` itself.
  const homed = useMachine((s) => s.homed);
  const softLimitsEnabled = useMachine((s) => s.softLimitsEnabled);
  const maxTravelMm = useMachine((s) => s.maxTravelMm);

  // Ref so the mount-time ready listener pushes the latest snapshot without
  // re-binding on every change.
  const snapRef = useRef(snap);
  snapRef.current = snap;

  // Push the project snapshot whenever it changes.
  useEffect(() => {
    void api.emitDrillSnapshot(snap);
  }, [snap]);

  // Relay the derived/firmware machine state (absent from the backend broadcast).
  useEffect(() => {
    void api.emitMachineDerived({ homed, softLimitsEnabled, maxTravelMm });
  }, [homed, softLimitsEnabled, maxTravelMm]);

  useBridgeListeners(() => [
    api.onDrillReady(() => {
      // Seed a freshly-opened window with the current snapshot + derived state.
      void api.emitDrillSnapshot(snapRef.current);
      const m = useMachine.getState();
      void api.emitMachineDerived({
        homed: m.homed,
        softLimitsEnabled: m.softLimitsEnabled,
        maxTravelMm: m.maxTravelMm,
      });
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
    // Drill window asks to open the panel editor (work-zero method 2 needs
    // alignment points, placed there). Window focus is handled by the sender.
    api.onOpenPanelEditor(() => useNavigation.getState().openProjectTab("panel")),
  ]);
}
