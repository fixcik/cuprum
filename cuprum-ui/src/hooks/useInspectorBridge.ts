import { useEffect } from "react";
import { useShell } from "@/shellStore";
import { api } from "@/lib/api";

/** Push the current project snapshot to every inspector window. */
function emitSnapshot() {
  const s = useShell.getState();
  return api.emitInspectorSnapshot({
    workingDir: s.workingDir,
    currentPath: s.currentPath,
    manifest: s.currentManifest,
  });
}

/** Main-window side of the inspector bridge. Mount once in App. Inspector windows
 *  are remote views: they receive snapshots and send edit intents; the main window
 *  stays the single writer of project state (undo/redo, autosave, repack). */
export function useInspectorBridge() {
  const manifest = useShell((s) => s.currentManifest);
  const workingDir = useShell((s) => s.workingDir);
  const currentPath = useShell((s) => s.currentPath);

  // Re-push on any change to the manifest, working dir, or open project.
  useEffect(() => {
    void emitSnapshot();
  }, [manifest, workingDir, currentPath]);

  useEffect(() => {
    const subs: Promise<() => void>[] = [
      api.onInspectorReady(() => void emitSnapshot()),
      api.onInspectorRename(({ designId, name }) => {
        void useShell.getState().renameDesign(designId, name);
      }),
      api.onInspectorSetLayerType(({ designId, path, type }) => {
        void useShell.getState().setDesignLayerType(designId, path, type);
      }),
      api.onInspectorArtifactsFresh(({ fresh }) => {
        useShell.getState().scheduleArtifactFlush(fresh);
      }),
    ];
    return () => {
      subs.forEach((p) => void p.then((un) => un()));
    };
  }, []);
}
