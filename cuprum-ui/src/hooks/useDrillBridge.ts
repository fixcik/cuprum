import { useEffect, useRef } from "react";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { buildDrillSnapshot } from "@/lib/drillSnapshot";
import { useBridgeListeners } from "@/hooks/useTauriListeners";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";

/** Main-window side of the drill-preview bridge. Mount once in App.
 *  The drill window is read-only (no intents), so this bridge only pushes
 *  snapshots — simpler than the add-design bridge. The snapshot also carries the
 *  shop settings (CNC profile, tools, DFM thresholds) so the drill window — with
 *  its own persisted store that only rehydrates on load — reflects edits live. */
export function useDrillBridge() {
  const designs = useShell((s) => s.currentManifest?.designs);
  const panel = useShell((s) => s.currentManifest?.panel);
  const placedSizes = usePlacedBoardSizes();
  // Subscribe to the settings that affect the drill plan so an edit re-pushes.
  const cncProfile = useSettings((s) => s.cncProfile);
  const tools = useSettings((s) => s.tools);
  const viaMaxDiameterMm = useSettings((s) => s.profile.viaMaxDiameterMm);
  const drillBitToleranceMm = useSettings((s) => s.profile.drillBitToleranceMm);

  // Keep a ref so the mount-time ready listener always reads the latest sizes
  // (usePlacedBoardSizes is a hook, not a store — no getState).
  const placedSizesRef = useRef(placedSizes);
  placedSizesRef.current = placedSizes;

  /** Push the current project + settings snapshot to the drill-preview window.
   *  Reads live shell/settings via getState() so the mount-time ready listener
   *  always sends the latest, regardless of closure capture. */
  const emitSnapshot = () => {
    const s = useShell.getState();
    const set = useSettings.getState();
    return api.emitDrillSnapshot(
      buildDrillSnapshot({
        workingDir: s.workingDir,
        manifest: s.currentManifest,
        placedSizes: placedSizesRef.current,
        cncProfile: set.cncProfile,
        tools: set.tools,
        viaMaxDiameterMm: set.profile.viaMaxDiameterMm,
        drillBitToleranceMm: set.profile.drillBitToleranceMm,
      }),
    );
  };

  // Re-push whenever project data OR shop settings change (covers imports, added
  // instances, fetched sizes, and live profile/tool edits).
  useEffect(() => {
    void emitSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designs, panel, placedSizes, cncProfile, tools, viaMaxDiameterMm, drillBitToleranceMm]);

  // Reply to the drill window's ready signal with a fresh snapshot.
  // Also handle drill-window intents (class override persisted by the main window,
  // which is the sole writer; snapshot re-push fires automatically on panel change).
  useBridgeListeners(() => [
    api.onDrillReady(() => {
      void emitSnapshot();
    }),
    api.onDrillSetClassOverride(
      ({ diameterKey, klass }) =>
        void useShell.getState().setDrillClassOverride(diameterKey, klass),
    ),
  ]);
}
