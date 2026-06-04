import { useEffect, useRef } from "react";
import { useShell } from "@/shellStore";
import { api } from "@/lib/api";
import { buildAddDesignSnapshot } from "@/lib/addDesignSnapshot";
import { useBridgeListeners } from "@/hooks/useTauriListeners";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";

/** Main-window side of the add-design bridge. Mount once in App. The add-design
 *  window is a remote control: it gets snapshots and sends intents; the main
 *  window stays the single writer of project state. */
export function useAddDesignBridge() {
  const designs = useShell((s) => s.currentManifest?.designs);
  const panel = useShell((s) => s.currentManifest?.panel);
  const placedSizes = usePlacedBoardSizes();

  // Keep a ref so the mount-time listener closure always reads the latest sizes
  // without needing to be recreated every time sizes change.
  const placedSizesRef = useRef(placedSizes);
  placedSizesRef.current = placedSizes;

  /** Push the current project snapshot to the add-design window. */
  const emitSnapshot = () => {
    const s = useShell.getState();
    return api.emitAddDesignSnapshot(
      buildAddDesignSnapshot({
        workingDir: s.workingDir,
        currentPath: s.currentPath,
        manifest: s.currentManifest,
        preselectDesignId: s.pendingAddDesignId,
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

  useBridgeListeners(() => [
    api.onAddDesignReady(() => {
      void emitSnapshot();
      // One-shot: the preselect was just carried by the ready snapshot.
      if (useShell.getState().pendingAddDesignId) useShell.setState({ pendingAddDesignId: null });
    }),
    api.onAddDesignImport(({ paths }) => void useShell.getState().addDesignsFromPaths(paths)),
    api.onAddDesignAddToPanel(async ({ designId, nest }) => {
      const r = await useShell.getState().addBoardInstances(designId, nest);
      void api.emitAddDesignResult(r);
    }),
  ]);
}
