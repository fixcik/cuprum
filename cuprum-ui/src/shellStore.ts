import { create } from "zustand";
import i18n from "@/i18n";
import { api, type LayerType, type Manifest, type PanelDoc, type ProjectDesign, type RecentProject, type RestorePointMeta, type Stackup } from "@/lib/api";
import { isProjectNotFound, projectDisplayName } from "@/lib/projectErrors";

export type View = "home" | "project" | "printer" | "settings";

interface ShellStore {
  view: View;
  recents: RecentProject[];
  recentsLoading: boolean;
  currentPath: string | null;
  /** Temp working dir the open `.cuprum` was extracted into; reads/renders hit
   *  loose files here. Null when no project is open. */
  workingDir: string | null;
  currentManifest: Manifest | null;
  error: string | null;
  homeNotice: string | null;

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
  makeRestorePoint: (label?: string) => Promise<void>;
  restoreTo: (id: string) => Promise<void>;
  refreshRestorePoints: () => Promise<void>;
  /** Private: persist a manifest as the new document (working-dir + .cuprum). */
  _persistManifest: (manifest: Manifest) => Promise<void>;
  /** Private: push the previous manifest onto the undo stack (caps length). */
  _recordUndo: (prev: Manifest) => void;
  /** Private: create an "opened" restore point only when the document differs
   *  from the newest existing point, so reopening an unchanged project does not
   *  stack duplicate auto points. */
  _maybeAutoOpenPoint: () => Promise<void>;

  /** CSS px per mm for the host display; defaults to the 96dpi CSS reference. */
  pxPerMm: number;
  /** Private guard — true once the native value has been fetched. */
  _scaleLoaded: boolean;
  loadDisplayScale: () => Promise<void>;

  setView: (v: View) => void;
  goHome: () => void;
  loadRecents: () => Promise<void>;
  newProject: () => Promise<void>;
  openProjectFromPicker: () => Promise<void>;
  openProjectByPath: (path: string) => Promise<void>;
  removeRecent: (path: string) => Promise<void>;
  updateProjectMetadata: (name: string, description: string) => Promise<void>;
  /** Write the panel blank (stackup -> manifest, dimensions -> panel.json). */
  savePanelConfig: (panel: PanelDoc, stackup: Stackup) => Promise<void>;
  /** Private: mirror the in-memory manifest into the working dir's loose
   *  manifest.json after a mutation (basis for crash recovery). */
  _mirrorManifest: (manifest: Manifest) => Promise<void>;

  /** Pick source ZIP(s) and add each as a new design to the open project
   *  (copied into the working dir, auto-classified, persisted via autosave). */
  addDesignsFromZips: () => Promise<void>;
  /** Add designs from already-resolved ZIP paths (e.g. an OS drag-and-drop drop),
   *  bypassing the file dialog. Same persist/undo path as `addDesignsFromZips`. */
  addDesignsFromPaths: (paths: string[]) => Promise<void>;
  /** Reassign one gerber's layer type within a design (undoable, persisted). */
  setDesignLayerType: (designId: string, gerberPath: string, type: LayerType) => Promise<void>;
  /** Remove a design from the project (undoable). Only the manifest reference is
   *  dropped; the gerber bytes stay on disk so undo/restore points stay valid. */
  removeDesign: (designId: string) => Promise<void>;
}

/** Strip directory + .cuprum extension to a display/default name. */
function stem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.cuprum$/i, "");
}

export const useShell = create<ShellStore>((set, get) => ({
  view: "home",
  recents: [],
  recentsLoading: false,
  currentPath: null,
  workingDir: null,
  currentManifest: null,
  error: null,
  homeNotice: null,
  undoStack: [],
  redoStack: [],
  restorePoints: [],
  docNonce: 0,
  historyBusy: false,
  pxPerMm: 96 / 25.4,
  _scaleLoaded: false,

  loadDisplayScale: async () => {
    // Cache once per launch; the native value never changes mid-session.
    if (get()._scaleLoaded) return;
    try {
      const v = await api.displayPxPerMm();
      if (v && isFinite(v) && v > 0) set({ pxPerMm: v, _scaleLoaded: true });
      else set({ _scaleLoaded: true });
    } catch {
      set({ _scaleLoaded: true });
    }
  },

  setView: (v) => set({ view: v }),
  goHome: () => set({ view: "home" }),

  loadRecents: async () => {
    set({ recentsLoading: true });
    try {
      const recents = await api.listRecentProjects();
      set({ recents });
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ recentsLoading: false });
    }
  },

  newProject: async () => {
    set({ homeNotice: null, error: null });
    try {
      const savePath = await api.pickSavePath("untitled.cuprum");
      if (!savePath) return;
      // Clean up any previously-open project's working dir before switching, so
      // switching projects never leaks a temp working dir.
      const prevWorkingDir = get().workingDir;
      if (prevWorkingDir) {
        try {
          await api.cleanupWorkdir(prevWorkingDir);
        } catch {
          /* best-effort: a stale working dir is GC'd at next startup */
        }
      }
      const name = stem(savePath);
      await api.createProject(savePath, name, []);
      // Give the fresh project a working-dir the same way `open` does, so a
      // subsequent import/edit has somewhere to extract into.
      const opened = await api.openProject(savePath);
      set({
        currentPath: savePath,
        workingDir: opened.workingDir,
        currentManifest: opened.manifest,
        view: "project",
        error: null,
      });
      await get().loadRecents();
      set({ undoStack: [], redoStack: [] });
      await get().refreshRestorePoints();
      await get()._maybeAutoOpenPoint();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  openProjectFromPicker: async () => {
    set({ homeNotice: null, error: null });
    try {
      const path = await api.pickProjectFile();
      if (!path) return;
      await get().openProjectByPath(path);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  openProjectByPath: async (path) => {
    set({ homeNotice: null, error: null });
    // Clean up any previously-open project's working dir before switching, so
    // switching projects never leaks a temp working dir.
    const prevWorkingDir = get().workingDir;
    if (prevWorkingDir) {
      try {
        await api.cleanupWorkdir(prevWorkingDir);
      } catch {
        /* best-effort: a stale working dir is GC'd at next startup */
      }
    }
    try {
      const opened = await api.openProject(path);
      set({
        currentPath: path,
        workingDir: opened.workingDir,
        currentManifest: opened.manifest,
        view: "project",
        error: null,
      });
      await get().loadRecents();
      set({ undoStack: [], redoStack: [] });
      await get().refreshRestorePoints();
      await get()._maybeAutoOpenPoint();
    } catch (e) {
      if (isProjectNotFound(e)) {
        const name = projectDisplayName(path, get().recents);
        try {
          await api.removeRecent(path);
        } catch {
          /* catalog cleanup is best-effort */
        }
        await get().loadRecents();
        set({
          homeNotice: i18n.t("home:notFoundRemoved", { name }),
          error: null,
        });
        return;
      }
      set({ error: String(e) });
    }
  },

  removeRecent: async (path) => {
    try {
      await api.removeRecent(path);
      await get().loadRecents();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  updateProjectMetadata: async (name, description) => {
    const path = get().currentPath;
    if (!path) return;
    const prev = get().currentManifest;
    try {
      const manifest = await api.updateProjectMetadata(path, name, description);
      if (prev) get()._recordUndo(prev);
      set({ currentManifest: manifest, error: null });
      await get()._mirrorManifest(manifest);
      await get().loadRecents();
    } catch (e) {
      if (isProjectNotFound(e)) {
        const displayName = projectDisplayName(path, get().recents);
        try {
          await api.removeRecent(path);
        } catch {
          /* catalog cleanup is best-effort */
        }
        // The source `.cuprum` vanished underneath us: drop the working dir too.
        const { workingDir } = get();
        if (workingDir) {
          try {
            await api.cleanupWorkdir(workingDir);
          } catch {
            /* best-effort: a stale working dir is GC'd at next startup */
          }
        }
        await get().loadRecents();
        set({
          view: "home",
          currentPath: null,
          workingDir: null,
          currentManifest: null,
          homeNotice: i18n.t("home:notFoundRemoved", { name: displayName }),
          error: null,
        });
        return;
      }
      set({ error: String(e) });
    }
  },

  savePanelConfig: async (panel, stackup) => {
    const path = get().currentPath;
    if (!path) return;
    try {
      const prev = get().currentManifest;
      const manifest = await api.configurePanel(path, panel, stackup);
      if (prev) get()._recordUndo(prev);
      set({ currentManifest: manifest, error: null });
      await get()._mirrorManifest(manifest);
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  _mirrorManifest: async (manifest) => {
    // Keep the working-dir's loose manifest.json in sync with the in-memory
    // manifest after any mutation (basis for crash recovery; Phase 1 still also
    // persists to .cuprum via the existing commands).
    const { workingDir } = get();
    if (workingDir) await api.writeWorkingManifest(workingDir, manifest);
  },

  _recordUndo: (prev) =>
    set((s) => ({ undoStack: [...s.undoStack, prev].slice(-100), redoStack: [] })),

  // Create an "opened" restore point only if the document differs from the
  // newest existing point — so reopening an unchanged project doesn't stack
  // identical auto points.
  _maybeAutoOpenPoint: async () => {
    const { workingDir, currentManifest, restorePoints } = get();
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
      await get().makeRestorePoint();
    } catch {
      /* auto restore point is best-effort */
    }
  },

  // Persist a manifest as the live document: working-dir loose file (instant)
  // + repack the .cuprum (autosave). No-op without an open project.
  _persistManifest: async (manifest) => {
    const { workingDir, currentPath } = get();
    if (!workingDir || !currentPath) return;
    await api.writeWorkingManifest(workingDir, manifest);
    await api.saveProject(workingDir, currentPath);
  },

  canUndo: () => get().undoStack.length > 0,
  canRedo: () => get().redoStack.length > 0,

  undo: async () => {
    if (get().historyBusy) return;
    const { undoStack, currentManifest } = get();
    if (undoStack.length === 0 || !currentManifest) return;
    set({ historyBusy: true });
    try {
      const prev = undoStack[undoStack.length - 1];
      set((s) => ({
        undoStack: s.undoStack.slice(0, -1),
        redoStack: [...s.redoStack, currentManifest],
        currentManifest: prev,
        docNonce: s.docNonce + 1,
      }));
      // _persistManifest writes the working-dir manifest first (the live source
      // of truth), so in-memory state stays consistent with the working dir even
      // when the .cuprum repack fails; no rollback needed.
      await get()._persistManifest(prev);
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ historyBusy: false });
    }
  },

  redo: async () => {
    if (get().historyBusy) return;
    const { redoStack, currentManifest } = get();
    if (redoStack.length === 0 || !currentManifest) return;
    set({ historyBusy: true });
    try {
      const next = redoStack[redoStack.length - 1];
      set((s) => ({
        redoStack: s.redoStack.slice(0, -1),
        undoStack: [...s.undoStack, currentManifest],
        currentManifest: next,
        docNonce: s.docNonce + 1,
      }));
      // _persistManifest writes the working-dir manifest first (the live source
      // of truth), so in-memory state stays consistent with the working dir even
      // when the .cuprum repack fails; no rollback needed.
      await get()._persistManifest(next);
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ historyBusy: false });
    }
  },

  refreshRestorePoints: async () => {
    const { workingDir } = get();
    if (!workingDir) return;
    try {
      set({ restorePoints: await api.listRestorePoints(workingDir) });
    } catch {
      /* listing is best-effort */
    }
  },

  makeRestorePoint: async (label) => {
    if (get().historyBusy) return;
    const { workingDir, currentPath } = get();
    if (!workingDir || !currentPath) return;
    set({ historyBusy: true });
    try {
      // Snapshot reads the working-dir manifest, which _mirrorManifest keeps current.
      await api.makeRestorePoint(workingDir, label);
      await api.saveProject(workingDir, currentPath); // flush so the .cuprum carries it
      await get().refreshRestorePoints();
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ historyBusy: false });
    }
  },

  restoreTo: async (id) => {
    if (get().historyBusy) return;
    const { workingDir, currentManifest } = get();
    if (!workingDir || !currentManifest) return;
    set({ historyBusy: true });
    try {
      const manifest = await api.readRestorePoint(workingDir, id);
      get()._recordUndo(currentManifest);
      set((s) => ({ currentManifest: manifest, docNonce: s.docNonce + 1 }));
      // _persistManifest writes the working-dir manifest first (the live source
      // of truth), so in-memory state stays consistent with the working dir even
      // when the .cuprum repack fails; no rollback needed.
      await get()._persistManifest(manifest);
    } catch (e) {
      set({ error: String(e) });
    } finally {
      set({ historyBusy: false });
    }
  },

  addDesignsFromZips: async () => {
    const zips = await api.pickZips();
    if (!zips || zips.length === 0) return;
    await get().addDesignsFromPaths(zips);
  },

  addDesignsFromPaths: async (paths) => {
    const { currentPath, workingDir, currentManifest } = get();
    if (!currentPath || !workingDir || !currentManifest) return;
    if (paths.length === 0) return;
    const prev = currentManifest;
    // Copy each ZIP into the working dir as a new design (sequential: each add
    // reserves its id from the gerbers/ dir the previous one just created).
    // Collect successes; if one fails, still commit the ones that succeeded so
    // their already-on-disk gerbers aren't orphaned, then surface the error.
    const added: ProjectDesign[] = [];
    let failure: unknown = null;
    for (const zip of paths) {
      try {
        added.push(await api.addDesignFromZip(workingDir, zip));
      } catch (e) {
        failure = e;
        break;
      }
    }
    try {
      if (added.length > 0) {
        const manifest: Manifest = { ...prev, designs: [...prev.designs, ...added] };
        get()._recordUndo(prev);
        set({ currentManifest: manifest, error: null });
        // Persist: write the loose manifest then repack the .cuprum so the freshly
        // copied gerbers land in the container too.
        await get()._persistManifest(manifest);
      }
    } catch (e) {
      failure = failure ?? e;
    }
    if (failure) set({ error: String(failure) });
  },

  setDesignLayerType: async (designId, gerberPath, type) => {
    const prev = get().currentManifest;
    if (!prev) return;
    const designs = prev.designs.map((d) =>
      d.id !== designId
        ? d
        : {
            ...d,
            gerbers: d.gerbers.map((g) =>
              g.path === gerberPath ? { ...g, layer_type: type } : g,
            ),
          },
    );
    const manifest: Manifest = { ...prev, designs };
    try {
      get()._recordUndo(prev);
      set({ currentManifest: manifest, error: null });
      await get()._persistManifest(manifest);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  removeDesign: async (designId) => {
    const prev = get().currentManifest;
    if (!prev) return;
    const designs = prev.designs.filter((d) => d.id !== designId);
    if (designs.length === prev.designs.length) return; // unknown id — nothing to do
    // Drop only the manifest reference; the gerber bytes stay in the working dir
    // (and the repacked .cuprum), so undo and restore points remain valid.
    const manifest: Manifest = { ...prev, designs };
    try {
      get()._recordUndo(prev);
      set({ currentManifest: manifest, error: null });
      await get()._persistManifest(manifest);
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
