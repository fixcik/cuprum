import { useEffect, useRef } from "react";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";
import { buildDrillSnapshot } from "@/lib/drillSnapshot";
import { useBridgeListeners } from "@/hooks/useTauriListeners";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";

/** Main-window side of the drill bridge. Mount once in App. The drill window is a
 *  remote control: it gets the project as a snapshot and follows the machine via the
 *  global `machine://status` broadcast (it does NOT take the telemetry Channel), so
 *  both windows stay live. The one machine field not in that broadcast — the
 *  JS-derived `homed` flag — is relayed here. The window sends machine/run commands
 *  directly via invoke; project mutations come back as intents (set-class-override). */
export function useDrillBridge() {
  const workingDir = useShell((s) => s.workingDir);
  const manifest = useShell((s) => s.currentManifest);
  const placedSizes = usePlacedBoardSizes();
  const cncProfile = useSettings((s) => s.cncProfile);
  const tools = useSettings((s) => s.tools);
  const viaMaxDiameterMm = useSettings((s) => s.profile.viaMaxDiameterMm);
  const drillBitToleranceMm = useSettings((s) => s.profile.drillBitToleranceMm);
  const homed = useMachine((s) => s.homed);

  // Refs so the mount-time listener closures always read the latest values without
  // being recreated on every change.
  const placedSizesRef = useRef(placedSizes);
  placedSizesRef.current = placedSizes;

  /** Push the current project snapshot to the drill window. Read settings fresh so
   *  a listener-driven push (drill:ready) carries the latest values. */
  const emitSnapshot = () => {
    const s = useSettings.getState();
    const sh = useShell.getState();
    return api.emitDrillSnapshot(
      buildDrillSnapshot({
        workingDir: sh.workingDir,
        manifest: sh.currentManifest,
        placedSizes: placedSizesRef.current,
        cncProfile: s.cncProfile,
        tools: s.tools,
        viaMaxDiameterMm: s.profile.viaMaxDiameterMm,
        drillBitToleranceMm: s.profile.drillBitToleranceMm,
      }),
    );
  };

  // Re-push when any snapshot input changes.
  useEffect(() => {
    void emitSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, manifest, placedSizes, cncProfile, tools, viaMaxDiameterMm, drillBitToleranceMm]);

  // Relay the JS-derived homed flag (absent from the backend broadcast).
  useEffect(() => {
    void api.emitMachineDerived({ homed });
  }, [homed]);

  useBridgeListeners(() => [
    api.onDrillReady(() => {
      void emitSnapshot();
      // Seed the window with the current derived flag right after it announces ready.
      void api.emitMachineDerived({ homed: useMachine.getState().homed });
    }),
    api.onDrillSetClassOverride(({ diameterKey, klass }) =>
      void useShell.getState().setDrillClassOverride(diameterKey, klass),
    ),
  ]);
}
