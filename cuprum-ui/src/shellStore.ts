import { create } from "zustand";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import i18n from "@/i18n";
import { api, type AddDesignResult, type BoardInstance, type LayerType, type Manifest, type PanelDoc, type ProjectDesign, type RecentProject, type RestorePointMeta, type Stackup, type ToolingHole, type ToolingHoleRole } from "@/lib/api";
import { buildAddDesignSnapshot } from "@/lib/addDesignSnapshot";
import { DEFAULT_STACKUP, DEFAULT_TOOLING_DIAMETER_MM, REGISTRATION_SET_MARGIN_MM, newPanelDoc } from "@/lib/panel";
import { packLayoutAvoiding, panelObstacles, clampToolingHoleCenter, registrationSetPositions } from "@/lib/panelPlacement";
import { type NestSettings } from "@/lib/nest";
import { isProjectNotFound, projectDisplayName } from "@/lib/projectErrors";

/** Debounce window before flushing freshly-computed artifacts into the .cuprum. */
const ARTIFACT_FLUSH_MS = 1500;
let _flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Serialize ALL packs (mutations, restore points, artifact flush): two concurrent
 *  packs race on the container write + gc_gerbers vs collect_entries. */
let _packChain: Promise<unknown> = Promise.resolve();
/** Count of packs queued-but-not-yet-settled, so the UI can show a "saving"
 *  spinner while any repack (autosave flush included) is in flight. */
let _packInFlight = 0;
/** Set when scheduleArtifactFlush is called while a pack is already in flight.
 *  Consumed once the queue drains: triggers exactly one trailing repack so no
 *  freshly-computed artifact is lost. */
let _flushDirty = false;
function serializePack(fn: () => Promise<void>): Promise<void> {
  _packInFlight += 1;
  if (_packInFlight === 1) useShell.setState({ saving: true });
  const run = () =>
    fn().finally(() => {
      _packInFlight -= 1;
      if (_packInFlight === 0) {
        useShell.setState({ saving: false });
        // If artifact flushes arrived while the pack queue was busy, fire one
        // trailing flush now that the queue is empty.  We clear the flag first
        // so a concurrent scheduleArtifactFlush (extremely unlikely here, but
        // possible) will start its own fresh debounce rather than be swallowed.
        if (_flushDirty) {
          _flushDirty = false;
          useShell.getState().scheduleArtifactFlush(true);
        }
      }
    });
  const next = _packChain.then(run, run);
  _packChain = next.catch(() => {});
  return next;
}

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
  /** True while any repack (`serializePack`: autosave flush, mutations, restore
   *  points) is in flight — drives the toolbar save spinner. */
  saving: boolean;

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
  /** Private: persist a manifest as the new document (working-dir + .cuprum). */
  _persistManifest: (manifest: Manifest) => Promise<void>;
  /** Private: push the previous manifest onto the undo stack (caps length). */
  _recordUndo: (prev: Manifest) => void;
  /** Private: create an "opened" restore point only when the document differs
   *  from the newest existing point, so reopening an unchanged project does not
   *  stack duplicate auto points. */
  _maybeAutoOpenPoint: () => Promise<void>;
  /** Schedule a debounced repack to flush freshly-computed artifacts into the
   *  .cuprum. No-op when `fresh` is false (artifact was served from cache). */
  scheduleArtifactFlush: (fresh: boolean) => void;

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
  /** Edit name/description of a recent project by its `.cuprum` path (not the open
   *  one). Writes the manifest, refreshes recents, and syncs the open project if it
   *  happens to be the same one. */
  updateRecentMetadata: (path: string, name: string, description: string) => Promise<void>;
  /** Write the panel blank (size + stackup) into the manifest, persisted via the
   *  shared working-dir + autosave path. */
  savePanelConfig: (panel: PanelDoc, stackup: Stackup) => Promise<void>;
  /** Pack copies of a design onto the panel using the given nest recipe.
   *  Returns an AddDesignResult so the add-design window can show a toast. */
  addBoardInstances: (designId: string, nest: NestSettings) => Promise<AddDesignResult>;
  /** Move the given instances by a delta (mm). One undo step. */
  moveInstances: (ids: string[], dxMm: number, dyMm: number) => Promise<void>;
  /** Set absolute x_mm/y_mm poses for a batch of instances. One undo step. */
  setInstancePoses: (poses: { id: string; x_mm: number; y_mm: number }[]) => Promise<void>;
  /** Set x_mm/y_mm/rotation_deg for a batch of instances. One undo step. */
  setInstanceTransforms: (items: { id: string; x_mm: number; y_mm: number; rotation_deg: number }[]) => Promise<void>;
  /** Remove the given instances from the panel. One undo step. */
  removeInstances: (ids: string[]) => Promise<void>;
  /** Set the rotation of the given instances to an absolute angle (deg). One undo. */
  rotateInstances: (ids: string[], absDeg: number) => Promise<void>;
  /** Add a delta to each instance's rotation (each about its own centre). One undo. */
  rotateInstancesBy: (ids: string[], deltaDeg: number) => Promise<void>;
  /** Duplicate the given instances (offset copy, new ids). Returns the new ids. One undo.
   *  `dxMm` / `dyMm` set the placement offset; callers should clamp these via
   *  `clampDeltaToPanel` before passing so copies stay within the panel. */
  duplicateInstances: (ids: string[], dxMm: number, dyMm: number) => Promise<string[]>;
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
  /** Rename a design's display name (undoable, persisted). No-op on unknown id,
   *  empty, or unchanged name. */
  renameDesign: (designId: string, name: string) => Promise<void>;
  /** Remove a design from the project (undoable). Only the manifest reference is
   *  dropped; the gerber bytes stay on disk so undo/restore points stay valid. */
  removeDesign: (designId: string) => Promise<void>;

  /** Per-design artifact-prep progress (0..1), keyed by designId. */
  artifactProgress: Record<string, number>;
  /** A card reports its ring fraction; store keeps the map for the global chip. */
  reportArtifactProgress: (designId: string, fraction: number) => void;
  /** Drop progress entries for designs no longer in the manifest (and on close). */
  pruneArtifactProgress: (liveIds: string[]) => void;
  /** Remove one design's progress entry — e.g. its card unmounted mid-prep, so
   *  the global chip shouldn't freeze at that design's partial fraction. */
  clearArtifactProgress: (designId: string) => void;

  /** Ephemeral opaque trace-session token per newly-imported design, keyed by
   *  designId. Set at import time; absent for designs opened from disk. Not
   *  persisted — an in-memory u32 has no meaning across launches. */
  traceSessions: Record<string, number>;
  /** Number of ZIP paths currently being imported (incremented per-path at start,
   *  decremented in finally). Drives the importing spinner on the designs tab. */
  importingCount: number;

  /** Design id to preselect when the add-design window opens next (one-shot). */
  pendingAddDesignId: string | null;
  /** Open the add-design window with a specific design pre-selected. */
  openAddDesignForDesign: (designId: string) => Promise<void>;

  /** Add a tooling hole centred at (xMm, yMm) with the default diameter.
   *  Returns the new hole id, or "" when no panel is open. */
  addToolingHole: (xMm: number, yMm: number) => Promise<string>;
  /** Translate an existing tooling hole by (dxMm, dyMm), clamped to the panel. */
  moveToolingHole: (id: string, dxMm: number, dyMm: number) => Promise<void>;
  /** Remove a tooling hole by id. */
  removeToolingHole: (id: string) => Promise<void>;
  /** Change the bore diameter of a tooling hole; re-clamps the centre. */
  setToolingHoleDiameter: (id: string, diameterMm: number) => Promise<void>;
  /** Change the role of a tooling hole. */
  setToolingHoleRole: (id: string, role: ToolingHoleRole) => Promise<void>;
  /** Add a corner registration set (4 holes) in one undo step. */
  addRegistrationSet: () => Promise<void>;
}

/** Strip directory + .cu/.cuprum extension to a display/default name. */
function stem(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.(cu|cuprum)$/i, "");
}

// Next "th-N" id beyond the current max — stable across deletions.
function nextToolingId(holes: ToolingHole[]): string {
  const max = holes.reduce((m, h) => {
    const n = parseInt(h.id.replace(/^th-/, ""), 10);
    return Number.isFinite(n) ? Math.max(m, n) : m;
  }, 0);
  return `th-${max + 1}`;
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
  saving: false,
  undoStack: [],
  redoStack: [],
  restorePoints: [],
  docNonce: 0,
  historyBusy: false,
  pxPerMm: 96 / 25.4,
  _scaleLoaded: false,
  artifactProgress: {},
  traceSessions: {},
  importingCount: 0,
  pendingAddDesignId: null,

  scheduleArtifactFlush: (fresh) => {
    if (!fresh) return;
    const { workingDir, currentPath } = get();
    if (!workingDir || !currentPath) return;
    // If a repack is already queued/running, just mark dirty and exit.  Once the
    // pack queue drains, serializePack will fire exactly one trailing flush so
    // freshly-computed artifacts are not lost.  This collapses N concurrent flush
    // requests into ≤2 actual api.saveProject calls.
    if (_packInFlight > 0) {
      _flushDirty = true;
      return;
    }
    const path = currentPath;
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      const s = get();
      if (s.currentPath !== path || !s.workingDir) return; // project changed/closed
      const wd = s.workingDir;
      void serializePack(() => api.saveProject(wd, path)).catch(() => {
        /* best-effort; the next fresh artifact reschedules */
      });
    }, ARTIFACT_FLUSH_MS);
  },

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
      const savePath = await api.pickSavePath("untitled.cu");
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
        // Drop any prior project's trace tokens: design ids are reused across
        // projects, so a stale token would mis-group a fresh import's traces.
        traceSessions: {},
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
    // Already on this project (e.g. re-clicked a recent, or an open-by-click both
    // parked a pending path AND emitted open-file for the same file) → just show
    // it, don't re-extract a fresh working dir.
    if (get().currentPath === path) {
      set({ view: "project", homeNotice: null, error: null });
      return;
    }
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
        // Drop any prior project's trace tokens: design ids are reused across
        // projects, so a stale token would mis-group a fresh import's traces.
        traceSessions: {},
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

  updateRecentMetadata: async (path, name, description) => {
    const n = name.trim();
    if (!n) return;
    try {
      const manifest = await api.updateProjectMetadata(path, n, description.trim());
      // If the edited recent is also the currently-open project, keep its in-memory
      // manifest in sync so the open view reflects the new name/description.
      if (get().currentPath === path) set({ currentManifest: manifest });
      set({ error: null });
      await get().loadRecents();
    } catch (e) {
      if (isProjectNotFound(e)) {
        const displayName = projectDisplayName(path, get().recents);
        try {
          await api.removeRecent(path);
        } catch {
          /* catalog cleanup is best-effort */
        }
        await get().loadRecents();
        set({ homeNotice: i18n.t("home:notFoundRemoved", { name: displayName }), error: null });
        return;
      }
      set({ error: String(e) });
    }
  },

  savePanelConfig: async (panel, stackup) => {
    const prev = get().currentManifest;
    if (!prev) return;
    // Persist the panel through the SAME working-dir + autosave path as every
    // other mutation. It used to write straight to the .cuprum container via
    // configure_panel and only mirror the loose manifest (no repack) — so a
    // serialized working-dir repack (artifact flush on open, another mutation)
    // would pack the panel-less loose manifest over the container, losing the
    // edit on reopen. Routing through _persistManifest puts the panel in the
    // loose manifest and repacks it via the serialized pack chain.
    const manifest: Manifest = { ...prev, panel, stackup };
    try {
      get()._recordUndo(prev);
      set({ currentManifest: manifest, error: null });
      await get()._persistManifest(manifest);
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  openAddDesignForDesign: async (designId) => {
    // Stash the id so the preselect reaches the window. Two delivery paths:
    //  - fresh window: it emits `ready` on mount → the bridge folds the pending
    //    id into that snapshot and clears it (one-shot).
    //  - already-open window: it won't remount or re-emit `ready` (the Rust
    //    command just focuses it), so push the preselect snapshot directly here
    //    and clear, otherwise the id would leak into the next reactive re-emit
    //    and override the user's manual selection.
    set({ pendingAddDesignId: designId });
    const existing = await WebviewWindow.getByLabel("add-design");
    await api.openAddDesignWindow();
    if (existing) {
      const s = get();
      await api.emitAddDesignSnapshot(
        buildAddDesignSnapshot({
          workingDir: s.workingDir,
          currentPath: s.currentPath,
          manifest: s.currentManifest,
          preselectDesignId: designId,
        }),
      );
      set({ pendingAddDesignId: null });
    }
  },

  addBoardInstances: async (designId, nest) => {
    const { workingDir, currentManifest } = get();
    if (!workingDir || !currentManifest) return { ok: false, messageKey: "panel.add.toast.noProject" };
    const design = currentManifest.designs.find((d) => d.id === designId);
    if (!design) return { ok: false, messageKey: "panel.add.toast.notFound" };
    // Board extent (mm) from cached metrics — needed to pack.
    let w: number;
    let h: number;
    try {
      const refs = design.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type }));
      const m = await api.projectBoardMetrics(workingDir, refs);
      w = m.metrics.board.widthMm;
      h = m.metrics.board.heightMm;
    } catch {
      return { ok: false, messageKey: "panel.add.toast.noSize" };
    }
    // Sizes of every already-placed design (cached metrics → cheap), so new copies
    // can avoid their footprints. Dedup by design_id; failures are skipped (that
    // instance just won't act as an obstacle).
    const placedIds = Array.from(new Set((get().currentManifest?.panel?.instances ?? []).map((i) => i.design_id)));
    const sizes: Record<string, { w: number; h: number }> = { [designId]: { w, h } };
    await Promise.all(
      placedIds.map(async (id) => {
        if (sizes[id]) return;
        const d = get().currentManifest?.designs.find((x) => x.id === id);
        if (!d) return;
        try {
          const m = await api.projectBoardMetrics(
            workingDir,
            d.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
          );
          sizes[id] = { w: m.metrics.board.widthMm, h: m.metrics.board.heightMm };
        } catch {
          /* unknown size → not an obstacle */
        }
      }),
    );
    // Re-read the live manifest after ALL async fetches so concurrent mutations
    // (e.g. an instance added/removed while we were fetching sizes) are not lost.
    // A default 100×100 blank is created when none exists yet (it will appear
    // pre-filled in the Panel editor).
    // Single add-design window, closed on success → no concurrent addBoardInstances
    // path, so the live re-read here is sufficient (no need to serialize the write).
    const panel: PanelDoc = get().currentManifest?.panel ?? newPanelDoc(100, 100);
    const stackup = get().currentManifest?.stackup ?? DEFAULT_STACKUP;
    const obstacles = panelObstacles(panel, sizes);
    const clearance = nest.enabled ? nest.gapMm : 0;
    const pack = packLayoutAvoiding(w, h, panel.width_mm, panel.height_mm, nest, obstacles, clearance);
    if (pack.n === 0) return { ok: false, messageKey: "panel.add.toast.noFit", params: { name: design.source_name } };
    // Append the packed copies of the selected design. Existing instances are kept
    // and not re-packed (mixed-panel overlap is resolved by the interactive editor).
    // packLayoutAvoiding anchors the (optionally swapped) footprint top-left at p.{x,y}.
    // Our pose model stores (x,y) as the UNROTATED board top-left with rotation
    // about the centre, so for a 90° copy shift (x,y) by ±(H−W)/2 / ±(W−H)/2 so the
    // centre-rotated AABB still fills the packed cell [p.x, p.x+H]×[p.y, p.y+W].
    const rotated = nest.enabled && nest.rotate;
    const added: BoardInstance[] = pack.placements.map((p) => ({
      id: crypto.randomUUID(),
      design_id: designId,
      x_mm: rotated ? p.x + (h - w) / 2 : p.x,
      y_mm: rotated ? p.y + (w - h) / 2 : p.y,
      rotation_deg: rotated ? 90 : 0,
      layer_ref: nest.side,
    }));
    const next: PanelDoc = { ...panel, instances: [...panel.instances, ...added] };
    await get().savePanelConfig(next, stackup);
    const overflow = pack.requested > pack.n;
    return {
      ok: true,
      messageKey: overflow ? "panel.add.toast.addedOverflow" : "panel.add.toast.addedN",
      params: { name: design.source_name, n: pack.n, requested: pack.requested },
    };
  },

  moveInstances: async (ids, dxMm, dyMm) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup || ids.length === 0 || (dxMm === 0 && dyMm === 0)) return;
    const sel = new Set(ids);
    const next: PanelDoc = {
      ...panel,
      instances: panel.instances.map((i) =>
        sel.has(i.id) ? { ...i, x_mm: i.x_mm + dxMm, y_mm: i.y_mm + dyMm } : i,
      ),
    };
    await get().savePanelConfig(next, stackup);
  },

  setInstancePoses: async (poses) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup || poses.length === 0) return;
    const byId = new Map(poses.map((p) => [p.id, p]));
    const next: PanelDoc = {
      ...panel,
      instances: panel.instances.map((i) => {
        const p = byId.get(i.id);
        return p ? { ...i, x_mm: p.x_mm, y_mm: p.y_mm } : i;
      }),
    };
    await get().savePanelConfig(next, stackup);
  },

  setInstanceTransforms: async (items) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup || items.length === 0) return;
    const byId = new Map(items.map((p) => [p.id, p]));
    const next: PanelDoc = {
      ...panel,
      instances: panel.instances.map((i) => {
        const p = byId.get(i.id);
        return p ? { ...i, x_mm: p.x_mm, y_mm: p.y_mm, rotation_deg: p.rotation_deg } : i;
      }),
    };
    await get().savePanelConfig(next, stackup);
  },

  removeInstances: async (ids) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup || ids.length === 0) return;
    const sel = new Set(ids);
    const next: PanelDoc = { ...panel, instances: panel.instances.filter((i) => !sel.has(i.id)) };
    await get().savePanelConfig(next, stackup);
  },

  rotateInstances: async (ids, absDeg) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup || ids.length === 0) return;
    const sel = new Set(ids);
    const next: PanelDoc = {
      ...panel,
      instances: panel.instances.map((i) => (sel.has(i.id) ? { ...i, rotation_deg: absDeg } : i)),
    };
    await get().savePanelConfig(next, stackup);
  },

  rotateInstancesBy: async (ids, deltaDeg) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup || ids.length === 0 || deltaDeg === 0) return;
    const sel = new Set(ids);
    const next: PanelDoc = {
      ...panel,
      instances: panel.instances.map((i) =>
        sel.has(i.id) ? { ...i, rotation_deg: (((i.rotation_deg + deltaDeg) % 360) + 360) % 360 } : i,
      ),
    };
    await get().savePanelConfig(next, stackup);
  },

  duplicateInstances: async (ids, dxMm, dyMm) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup || ids.length === 0) return [];
    const sel = new Set(ids);
    const copies = panel.instances
      .filter((i) => sel.has(i.id))
      .map((i) => ({ ...i, id: crypto.randomUUID(), x_mm: i.x_mm + dxMm, y_mm: i.y_mm + dyMm }));
    const next: PanelDoc = { ...panel, instances: [...panel.instances, ...copies] };
    await get().savePanelConfig(next, stackup);
    return copies.map((c) => c.id);
  },

  addToolingHole: async (xMm, yMm) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup) return "";
    const r = DEFAULT_TOOLING_DIAMETER_MM / 2;
    const { x, y } = clampToolingHoleCenter(xMm, yMm, r, panel.width_mm, panel.height_mm);
    const id = nextToolingId(panel.tooling_holes);
    const hole: ToolingHole = { id, x_mm: x, y_mm: y, diameter_mm: DEFAULT_TOOLING_DIAMETER_MM, role: "registration" };
    const next: PanelDoc = { ...panel, tooling_holes: [...panel.tooling_holes, hole] };
    await get().savePanelConfig(next, stackup);
    return id;
  },

  moveToolingHole: async (id, dxMm, dyMm) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup) return;
    const next: PanelDoc = {
      ...panel,
      tooling_holes: panel.tooling_holes.map((h) => {
        if (h.id !== id) return h;
        const { x, y } = clampToolingHoleCenter(h.x_mm + dxMm, h.y_mm + dyMm, h.diameter_mm / 2, panel.width_mm, panel.height_mm);
        return { ...h, x_mm: x, y_mm: y };
      }),
    };
    await get().savePanelConfig(next, stackup);
  },

  removeToolingHole: async (id) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup) return;
    const next: PanelDoc = { ...panel, tooling_holes: panel.tooling_holes.filter((h) => h.id !== id) };
    await get().savePanelConfig(next, stackup);
  },

  setToolingHoleDiameter: async (id, diameterMm) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup) return;
    const next: PanelDoc = {
      ...panel,
      tooling_holes: panel.tooling_holes.map((h) => {
        if (h.id !== id) return h;
        const { x, y } = clampToolingHoleCenter(h.x_mm, h.y_mm, diameterMm / 2, panel.width_mm, panel.height_mm);
        return { ...h, diameter_mm: diameterMm, x_mm: x, y_mm: y };
      }),
    };
    await get().savePanelConfig(next, stackup);
  },

  setToolingHoleRole: async (id, role) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup) return;
    const next: PanelDoc = {
      ...panel,
      tooling_holes: panel.tooling_holes.map((h) => (h.id === id ? { ...h, role } : h)),
    };
    await get().savePanelConfig(next, stackup);
  },

  addRegistrationSet: async () => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup) return;
    const positions = registrationSetPositions(panel.width_mm, panel.height_mm, REGISTRATION_SET_MARGIN_MM);
    let holes = [...panel.tooling_holes];
    for (const pos of positions) {
      const id = nextToolingId(holes);
      holes = [...holes, { id, x_mm: pos.x, y_mm: pos.y, diameter_mm: DEFAULT_TOOLING_DIAMETER_MM, role: "registration" }];
    }
    const next: PanelDoc = { ...panel, tooling_holes: holes };
    await get().savePanelConfig(next, stackup);
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
      await get().makeRestorePoint(undefined, true);
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
    await serializePack(() => api.saveProject(workingDir, currentPath));
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

  makeRestorePoint: async (label, auto = false) => {
    if (get().historyBusy) return;
    const { workingDir, currentPath } = get();
    if (!workingDir || !currentPath) return;
    set({ historyBusy: true });
    try {
      // Snapshot reads the working-dir manifest, which _mirrorManifest keeps current.
      await api.makeRestorePoint(workingDir, label, auto);
      await serializePack(() => api.saveProject(workingDir, currentPath)); // flush so the .cuprum carries it
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
    set((s) => ({ importingCount: s.importingCount + paths.length }));
    try {
      const prev = currentManifest;
      // Copy each ZIP into the working dir as a new design (sequential: each add
      // reserves its id from the gerbers/ dir the previous one just created).
      // Collect successes; if one fails, still commit the ones that succeeded so
      // their already-on-disk gerbers aren't orphaned, then surface the error.
      const added: ProjectDesign[] = [];
      const newTraceSessions: Record<string, number> = {};
      let failure: unknown = null;
      for (const zip of paths) {
        try {
          const result = await api.addDesignFromZip(workingDir, zip);
          added.push(result.design);
          if (result.traceSession != null) {
            newTraceSessions[result.design.id] = result.traceSession;
          }
        } catch (e) {
          failure = e;
          break;
        }
      }
      try {
        if (added.length > 0) {
          const manifest: Manifest = { ...prev, designs: [...prev.designs, ...added] };
          get()._recordUndo(prev);
          set((s) => ({
            currentManifest: manifest,
            error: null,
            traceSessions: Object.keys(newTraceSessions).length > 0
              ? { ...s.traceSessions, ...newTraceSessions }
              : s.traceSessions,
          }));
          // Persist: write the loose manifest then repack the .cuprum so the freshly
          // copied gerbers land in the container too.
          await get()._persistManifest(manifest);
        }
      } catch (e) {
        failure = failure ?? e;
      }
      if (failure) set({ error: String(failure) });
    } finally {
      set((s) => ({ importingCount: Math.max(0, s.importingCount - paths.length) }));
    }
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

  renameDesign: async (designId, name) => {
    const prev = get().currentManifest;
    if (!prev) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const designs = prev.designs.map((d) =>
      d.id === designId && d.source_name !== trimmed ? { ...d, source_name: trimmed } : d,
    );
    // Unknown id or unchanged name → every entry kept its reference: no-op (don't
    // churn the undo stack or rewrite the container).
    if (designs.every((d, i) => d === prev.designs[i])) return;
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
    // Drop the manifest reference AND cascade-remove any placements of this design
    // from the panel, so a delete never leaves dangling BoardInstances behind (one
    // undo step). The gerber bytes stay in the working dir (and the repacked
    // .cuprum), so undo and restore points remain valid.
    const panel = prev.panel
      ? { ...prev.panel, instances: prev.panel.instances.filter((i) => i.design_id !== designId) }
      : prev.panel;
    const manifest: Manifest = { ...prev, designs, panel };
    try {
      get()._recordUndo(prev);
      set({ currentManifest: manifest, error: null });
      await get()._persistManifest(manifest);
    } catch (e) {
      set({ error: String(e) });
    }
  },

  reportArtifactProgress: (designId, fraction) => {
    set((s) => ({ artifactProgress: { ...s.artifactProgress, [designId]: fraction } }));
  },
  pruneArtifactProgress: (liveIds) => {
    set((s) => {
      const live = new Set(liveIds);
      const next: Record<string, number> = {};
      for (const [id, f] of Object.entries(s.artifactProgress)) {
        if (live.has(id)) next[id] = f;
      }
      return { artifactProgress: next };
    });
  },
  clearArtifactProgress: (designId) => {
    set((s) => {
      if (!(designId in s.artifactProgress)) return s;
      const next = { ...s.artifactProgress };
      delete next[designId];
      return { artifactProgress: next };
    });
  },
}));
