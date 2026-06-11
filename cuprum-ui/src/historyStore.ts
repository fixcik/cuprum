import { create } from "zustand";
import { api, type Manifest, type RestorePointMeta } from "@/lib/api";
import { useShell } from "@/shellStore";
import { useNavigation } from "@/navigationStore";
import { serializePack } from "@/lib/projectPack";

interface HistoryStore {
  /** In-session document history. Snapshots are whole manifests. */
  undoStack: Manifest[];
  redoStack: Manifest[];
  /** Persistent restore points for the open project (newest first). */
  restorePoints: RestorePointMeta[];
  /** Bumped on undo/redo/restore so editors with local state (PanelEditor)
   *  re-sync from the manifest. */
  docNonce: number;
  /** True while a history op (undo/redo/restoreTo/makeRestorePoint) is in
   *  flight; blocks concurrent history ops to prevent overlapping repacks. */
  historyBusy: boolean;

  canUndo: () => boolean;
  canRedo: () => boolean;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  makeRestorePoint: (label?: string, auto?: boolean) => Promise<void>;
  restoreTo: (id: string) => Promise<void>;
  refreshRestorePoints: () => Promise<void>;
  /** Push the previous manifest onto the undo stack (caps length). */
  recordUndo: (prev: Manifest) => void;
  /** Bump docNonce. Called by `useShell._applyManifest` immediately after it swaps
   *  the live manifest, so editors keyed on docNonce always re-sync against the
   *  NEW manifest (manifest set first, nonce second — never a stale read). */
  _bumpDocNonce: () => void;
  /** Create an "opened" restore point only when the document differs from the
   *  newest existing point, so reopening an unchanged project does not stack
   *  duplicate auto points. */
  _maybeAutoOpenPoint: () => Promise<void>;
  /** Reset the in-session undo/redo history (on project switch). Restore points
   *  are reloaded separately via refreshRestorePoints. */
  reset: () => void;
}

export const useHistory = create<HistoryStore>((set, get) => ({
  undoStack: [],
  redoStack: [],
  restorePoints: [],
  docNonce: 0,
  historyBusy: false,

  recordUndo: (prev) =>
    set((s) => ({ undoStack: [...s.undoStack, prev].slice(-100), redoStack: [] })),

  _bumpDocNonce: () => set((s) => ({ docNonce: s.docNonce + 1 })),

  reset: () => set({ undoStack: [], redoStack: [] }),

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,

  undo: async () => {
    if (get().historyBusy) return;
    const { undoStack } = get();
    const currentManifest = useShell.getState().currentManifest;
    if (undoStack.length === 0 || !currentManifest) return;
    set({ historyBusy: true });
    try {
      const prev = undoStack[undoStack.length - 1];
      set((s) => ({
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, currentManifest],
      }));
      // _applyManifest swaps the live manifest then bumps docNonce (in that order)
      // so the PanelEditor re-sync sees the new manifest. It also writes the
      // working-dir manifest first (the live source
      // of truth), so in-memory state stays consistent with the working dir even
      // when the .cuprum repack fails; no rollback needed.
      await useShell.getState()._applyManifest(prev);
    } catch (e) {
      useNavigation.getState().setError(String(e));
    } finally {
      set({ historyBusy: false });
    }
  },

  redo: async () => {
    if (get().historyBusy) return;
    const { redoStack } = get();
    const currentManifest = useShell.getState().currentManifest;
    if (redoStack.length === 0 || !currentManifest) return;
    set({ historyBusy: true });
    try {
      const next = redoStack[redoStack.length - 1];
      set((s) => ({
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, currentManifest],
      }));
      // _applyManifest swaps the live manifest then bumps docNonce (in that order)
      // so the PanelEditor re-sync sees the new manifest. It also writes the
      // working-dir manifest first (the live source
      // of truth), so in-memory state stays consistent with the working dir even
      // when the .cuprum repack fails; no rollback needed.
      await useShell.getState()._applyManifest(next);
    } catch (e) {
      useNavigation.getState().setError(String(e));
    } finally {
      set({ historyBusy: false });
    }
  },

  refreshRestorePoints: async () => {
    const { workingDir } = useShell.getState();
    if (!workingDir) return;
    try {
      set({ restorePoints: await api.listRestorePoints(workingDir) });
    } catch {
      /* listing is best-effort */
    }
  },

  makeRestorePoint: async (label, auto = false) => {
    if (get().historyBusy) return;
    const { workingDir, currentPath } = useShell.getState();
    if (!workingDir || !currentPath) return;
    set({ historyBusy: true });
    try {
      // Snapshot reads the working-dir manifest, which _mirrorManifest keeps current.
      await api.makeRestorePoint(workingDir, label, auto);
      await serializePack(() => api.saveProject(workingDir, currentPath)); // flush so the .cuprum carries it
      await get().refreshRestorePoints();
    } catch (e) {
      useNavigation.getState().setError(String(e));
    } finally {
      set({ historyBusy: false });
    }
  },

  restoreTo: async (id) => {
    if (get().historyBusy) return;
    const { workingDir, currentManifest } = useShell.getState();
    if (!workingDir || !currentManifest) return;
    set({ historyBusy: true });
    try {
      const manifest = await api.readRestorePoint(workingDir, id);
      get().recordUndo(currentManifest);
      // _applyManifest swaps the live manifest then bumps docNonce (in that order)
      // so the PanelEditor re-sync sees the new manifest. It also writes the
      // working-dir manifest first (the live source of truth), so in-memory state
      // stays consistent with the working dir even when the .cuprum repack fails.
      await useShell.getState()._applyManifest(manifest);
    } catch (e) {
      useNavigation.getState().setError(String(e));
    } finally {
      set({ historyBusy: false });
    }
  },

  // Create an "opened" restore point only if the document differs from the
  // newest existing point — so reopening an unchanged project doesn't stack
  // identical auto points.
  _maybeAutoOpenPoint: async () => {
    const { workingDir, currentManifest } = useShell.getState();
    const { restorePoints } = get();
    if (!workingDir || !currentManifest) return;
    if (restorePoints.length > 0) {
      try {
        const newest = await api.readRestorePoint(workingDir, restorePoints[0].id);
        if (JSON.stringify(newest) === JSON.stringify(currentManifest)) return; // unchanged
      } catch {
        /* fall through and create the point */
      }
    }
    try {
      await get().makeRestorePoint(undefined, true);
    } catch {
      /* auto restore point is best-effort */
    }
  },
}));
