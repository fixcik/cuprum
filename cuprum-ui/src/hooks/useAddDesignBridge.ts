import { useEffect } from "react";
import { useShell } from "@/shellStore";
import { api } from "@/lib/api";
import { buildAddDesignSnapshot } from "@/lib/addDesignSnapshot";

/** Push the current project snapshot to the add-design window. */
function emitSnapshot() {
  const s = useShell.getState();
  return api.emitAddDesignSnapshot(
    buildAddDesignSnapshot({
      workingDir: s.workingDir,
      currentPath: s.currentPath,
      manifest: s.currentManifest,
      preselectDesignId: s.pendingAddDesignId,
    }),
  );
}

/** Main-window side of the add-design bridge. Mount once in App. The add-design
 *  window is a remote control: it gets snapshots and sends intents; the main
 *  window stays the single writer of project state. */
export function useAddDesignBridge() {
  const designs = useShell((s) => s.currentManifest?.designs);
  const panel = useShell((s) => s.currentManifest?.panel);

  // Re-push the snapshot whenever the designs list or panel changes (covers
  // import results and added instances).
  useEffect(() => {
    void emitSnapshot();
  }, [designs, panel]);

  useEffect(() => {
    const subs: Promise<() => void>[] = [
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
    ];
    return () => {
      subs.forEach((p) => void p.then((un) => un()));
    };
  }, []);
}
