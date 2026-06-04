import { useEffect, useRef } from "react";
import { useShell } from "@/shellStore";
import { api } from "@/lib/api";
import { buildDrillSnapshot } from "@/lib/drillSnapshot";
import { useBridgeListeners } from "@/hooks/useTauriListeners";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";

/** Main-window side of the drill-preview bridge. Mount once in App.
 *  The drill window is read-only (no intents), so this bridge only pushes
 *  snapshots — simpler than the add-design bridge. */
export function useDrillBridge() {
  const designs = useShell((s) => s.currentManifest?.designs);
  const panel = useShell((s) => s.currentManifest?.panel);
  const placedSizes = usePlacedBoardSizes();

  // Keep a ref so the mount-time listener closure always reads the latest sizes
  // without needing to be recreated every time sizes change.
  const placedSizesRef = useRef(placedSizes);
  placedSizesRef.current = placedSizes;

  /** Push the current project snapshot to the drill-preview window. */
  const emitSnapshot = () => {
    const s = useShell.getState();
    return api.emitDrillSnapshot(
      buildDrillSnapshot({
        workingDir: s.workingDir,
        manifest: s.currentManifest,
        placedSizes: placedSizesRef.current,
      }),
    );
  };

  // Re-push the snapshot whenever the designs list, panel, or resolved sizes
  // change (covers import results, added instances, and freshly fetched sizes).
  useEffect(() => {
    void emitSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designs, panel, placedSizes]);

  // Reply to the drill window's ready signal with a fresh snapshot.
  useBridgeListeners(() => [
    api.onDrillReady(() => {
      void emitSnapshot();
    }),
  ]);
}
