import { create } from "zustand";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import i18n from "@/i18n";
import { api, type AddDesignResult, type BoardInstance, type DrillClass, type FiducialParams, type KeepOutZone, type LayerType, type Manifest, type PanelDoc, type ProjectDesign, type RecentProject, type Stackup, type ToolingHole, type ToolingHoleRole } from "@/lib/api";
import { buildAddDesignSnapshot } from "@/lib/addDesignSnapshot";
import { DEFAULT_STACKUP, DEFAULT_TOOLING_DIAMETER_MM, newPanelDoc } from "@/lib/panel";
import { panelObstacles, clampToolingHoleCenter, registrationSetPositions, clampZoneRect, placeFiducials, KEEPOUT_MIN_MM } from "@/lib/panelPlacement";
import { solvePanelPlacements } from "@/lib/packSolve";
import { type NestSettings } from "@/lib/nest";
import { isProjectNotFound, projectDisplayName } from "@/lib/projectErrors";
import { saveLastSession } from "@/lib/lastSession";
import { useSettings } from "@/settingsStore";
import { metricsCache } from "@/lib/metricsCache";
import { serializePack } from "@/lib/projectPack";
import { useArtifacts } from "@/artifactsStore";
import { useNavigation } from "@/navigationStore";
import { useHistory } from "@/historyStore";

// The navigation domain (view + display scale + Home error/notice) lives in
// `useNavigation`. Re-exported here so existing `import { View } from "@/shellStore"`
// consumers keep resolving.
export type { View } from "@/navigationStore";

// Labels of the separate operation windows that own a live, journalled run. While
// any is open, the run-journal reconcile (orphan sweep) is skipped so a live row
// isn't mistaken for an orphan. Keep in sync with the backend window builders.
const OP_RUN_WINDOW_LABELS = ["drill", "expose", "mill"] as const;

interface ShellStore {
  recents: RecentProject[];
  recentsLoading: boolean;
  currentPath: string | null;
  /** Temp working dir the open `.cuprum` was extracted into; reads/renders hit
   *  loose files here. Null when no project is open. */
  workingDir: string | null;
  currentManifest: Manifest | null;
  /** True while any repack (`serializePack`: autosave flush, mutations, restore
   *  points) is in flight — drives the toolbar save spinner. */
  saving: boolean;

  /** Private: persist a manifest as the new document (working-dir + .cuprum). */
  _persistManifest: (manifest: Manifest) => Promise<void>;
  /** Private: set the manifest as the live document WITHOUT recording undo, then
   *  persist it. The single cross-store "handle" `useHistory` uses to apply an
   *  undo/redo/restore target (behaviour matches the old in-store set + persist). */
  _applyManifest: (manifest: Manifest) => Promise<void>;

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

  /** Design id to preselect when the add-design window opens next (one-shot). */
  pendingAddDesignId: string | null;
  /** Open the add-design window with a specific design pre-selected. */
  openAddDesignForDesign: (designId: string) => Promise<void>;

  /** params_json to prefill the drill window with when it next becomes ready
   *  ("repeat run"). One-shot: the drill bridge emits it on drill:ready and clears. */
  pendingDrillPrefill: string | null;
  setPendingDrillPrefill: (paramsJson: string | null) => void;

  /** params_json to prefill the expose window with when it next becomes ready
   *  ("repeat run"). One-shot: the expose bridge emits it on expose:ready and clears. */
  pendingExposePrefill: string | null;
  setPendingExposePrefill: (paramsJson: string | null) => void;

  /** Add a tooling hole centred at (xMm, yMm) with the default diameter.
   *  Returns the new hole id, or "" when no panel is open. */
  addToolingHole: (xMm: number, yMm: number, diameterMm?: number) => Promise<string>;
  /** Translate an existing tooling hole by (dxMm, dyMm), clamped to the panel. */
  moveToolingHole: (id: string, dxMm: number, dyMm: number) => Promise<void>;
  /** Remove a tooling hole by id. */
  removeToolingHole: (id: string) => Promise<void>;
  /** Change the bore diameter of a tooling hole; re-clamps the centre. */
  setToolingHoleDiameter: (id: string, diameterMm: number) => Promise<void>;
  /** Change the role of a tooling hole. */
  setToolingHoleRole: (id: string, role: ToolingHoleRole) => Promise<void>;
  /** Set or clear (klass=null) the drill-class override for a diameter bucket
   *  (key = round(diameterMm*1000) as string). Persisted in the panel manifest. */
  setDrillClassOverride: (diameterKey: string, klass: DrillClass | null) => Promise<void>;
  /** Add a corner registration set (4 holes) in one undo step. */
  addRegistrationSet: (opts: { count: 2 | 4; marginMm: number; diameterMm: number; replace: boolean }) => Promise<void>;
  /** Place fiducial holes using the auto-fiducial parameters, persisting the
   *  params into the panel doc so the dialog can restore them on next open.
   *  When `replace` is true, existing tooling holes are cleared first. */
  addAutoFiducials: (params: FiducialParams, replace: boolean) => Promise<void>;

  /** Add a keep-out zone to the panel. Returns the new zone id, or "" when no panel
   *  is open. Width/height are normalised to positive values; the zone is clamped
   *  into [0, panelW] × [0, panelH]. */
  addKeepOutZone: (z: { x_mm: number; y_mm: number; width_mm: number; height_mm: number }) => Promise<string>;
  /** Resize a keep-out zone; new rect is normalised and clamped into the panel. */
  resizeKeepOutZone: (id: string, rect: { x_mm: number; y_mm: number; width_mm: number; height_mm: number }) => Promise<void>;
  /** Translate the given keep-out zones by (dxMm, dyMm), clamped to the panel. */
  moveKeepOutZones: (ids: string[], dxMm: number, dyMm: number) => Promise<void>;
  /** Remove the given keep-out zones. */
  removeKeepOutZones: (ids: string[]) => Promise<void>;
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
  recents: [],
  recentsLoading: false,
  currentPath: null,
  workingDir: null,
  currentManifest: null,
  saving: false,
  pendingAddDesignId: null,
  pendingDrillPrefill: null,
  setPendingDrillPrefill: (paramsJson) => set({ pendingDrillPrefill: paramsJson }),
  pendingExposePrefill: null,
  setPendingExposePrefill: (paramsJson) => set({ pendingExposePrefill: paramsJson }),

  loadRecents: async () => {
    set({ recentsLoading: true });
    try {
      const recents = await api.listRecentProjects();
      set({ recents });
    } catch (e) {
      useNavigation.getState().setError(String(e));
    } finally {
      set({ recentsLoading: false });
    }
  },

  newProject: async () => {
    useNavigation.getState().setHomeNotice(null);
    useNavigation.getState().setError(null);
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
      // Drop any prior project's per-session artifact state (trace tokens, prep
      // progress, import counters): design ids are reused across projects, so a
      // stale token would mis-group a fresh import's traces.
      useArtifacts.getState().reset();
      useNavigation.getState().setView("project");
      set({
        currentPath: savePath,
        workingDir: opened.workingDir,
        currentManifest: opened.manifest,
      });
      useNavigation.getState().setError(null);
      await get().loadRecents();
      useHistory.getState().reset();
      await useHistory.getState().refreshRestorePoints();
      await useHistory.getState()._maybeAutoOpenPoint();
    } catch (e) {
      useNavigation.getState().setError(String(e));
    }
  },

  openProjectFromPicker: async () => {
    useNavigation.getState().setHomeNotice(null);
    useNavigation.getState().setError(null);
    try {
      const path = await api.pickProjectFile();
      if (!path) return;
      await get().openProjectByPath(path);
    } catch (e) {
      useNavigation.getState().setError(String(e));
    }
  },

  openProjectByPath: async (path) => {
    // Already on this project (e.g. re-clicked a recent, or an open-by-click both
    // parked a pending path AND emitted open-file for the same file) → just show
    // it, don't re-extract a fresh working dir.
    if (get().currentPath === path) {
      useNavigation.getState().setView("project");
      useNavigation.getState().setHomeNotice(null);
      useNavigation.getState().setError(null);
      return;
    }
    useNavigation.getState().setHomeNotice(null);
    useNavigation.getState().setError(null);
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
      // Drop any prior project's per-session artifact state (trace tokens, prep
      // progress, import counters): design ids are reused across projects, so a
      // stale token would mis-group a fresh import's traces.
      useArtifacts.getState().reset();
      useNavigation.getState().setView("project");
      set({
        currentPath: path,
        workingDir: opened.workingDir,
        currentManifest: opened.manifest,
      });
      // Reconcile orphaned run-journal rows: a run is window-driven and can't
      // outlive its window, so a still-open row is from a window closed mid-run.
      // Skip when an operation window (drill/expose/mill) is currently open — it
      // may own a LIVE, not-yet-finished run whose row we'd wrongly close (the
      // navigate-away-then-back case). Best-effort, fire-and-forget; orphans left
      // behind get swept the next time the project opens with no op window up.
      void (async () => {
        const opWindows = await Promise.all(
          OP_RUN_WINDOW_LABELS.map((label) => WebviewWindow.getByLabel(label)),
        );
        if (opWindows.some((w) => w !== null)) return;
        await api.operationLog.reconcile(path);
      })().catch(() => {});
      useNavigation.getState().setError(null);
      await get().loadRecents();
      useHistory.getState().reset();
      await useHistory.getState().refreshRestorePoints();
      await useHistory.getState()._maybeAutoOpenPoint();
    } catch (e) {
      if (isProjectNotFound(e)) {
        const name = projectDisplayName(path, get().recents);
        try {
          await api.removeRecent(path);
        } catch {
          /* catalog cleanup is best-effort */
        }
        await get().loadRecents();
        useNavigation.getState().setHomeNotice(i18n.t("home:notFoundRemoved", { name }));
        useNavigation.getState().setError(null);
        return;
      }
      useNavigation.getState().setError(String(e));
    }
  },

  removeRecent: async (path) => {
    try {
      await api.removeRecent(path);
      await get().loadRecents();
    } catch (e) {
      useNavigation.getState().setError(String(e));
    }
  },

  updateProjectMetadata: async (name, description) => {
    const path = get().currentPath;
    if (!path) return;
    const prev = get().currentManifest;
    try {
      const manifest = await api.updateProjectMetadata(path, name, description);
      if (prev) useHistory.getState().recordUndo(prev);
      set({ currentManifest: manifest });
      useNavigation.getState().setError(null);
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
        useNavigation.getState().setView("home");
        set({
          currentPath: null,
          workingDir: null,
          currentManifest: null,
        });
        useNavigation.getState().setHomeNotice(i18n.t("home:notFoundRemoved", { name: displayName }));
        useNavigation.getState().setError(null);
        return;
      }
      useNavigation.getState().setError(String(e));
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
      useNavigation.getState().setError(null);
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
        useNavigation.getState().setHomeNotice(i18n.t("home:notFoundRemoved", { name: displayName }));
        useNavigation.getState().setError(null);
        return;
      }
      useNavigation.getState().setError(String(e));
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
      useHistory.getState().recordUndo(prev);
      set({ currentManifest: manifest });
      useNavigation.getState().setError(null);
      await get()._persistManifest(manifest);
    } catch (e) {
      useNavigation.getState().setError(String(e));
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
      const m = await metricsCache.get(workingDir, refs);
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
          const m = await metricsCache.get(
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
    const obstacles = panelObstacles(panel, sizes, { clampRadiusMm: useSettings.getState().profile.toolingClampRadiusMm });
    const clearance = nest.enabled ? nest.gapMm : 0;
    // Greedy-then-solver (shared with the add-design preview so counts agree): fast
    // grid for simple panels, dense Rust solve only when greedy falls short.
    const { placements, requested } = await solvePanelPlacements({
      boardW: w,
      boardH: h,
      panelW: panel.width_mm,
      panelH: panel.height_mm,
      nest,
      obstacles,
      clearanceMm: clearance,
    });
    if (placements.length === 0) return { ok: false, messageKey: "panel.add.toast.noFit", params: { name: design.source_name } };
    // Append the packed copies of the selected design. Existing instances are kept
    // and not re-packed (mixed-panel overlap is resolved by the interactive editor).
    // Each placement is the (optionally rotated) footprint top-left + its 90° flag.
    // Our pose model stores (x,y) as the UNROTATED board top-left with rotation about
    // the centre, so for a 90° copy shift (x,y) by ±(H−W)/2 / ±(W−H)/2 so the
    // centre-rotated AABB still fills the packed cell.
    const added: BoardInstance[] = placements.map((p) => ({
      id: crypto.randomUUID(),
      design_id: designId,
      x_mm: p.rotated ? p.x + (h - w) / 2 : p.x,
      y_mm: p.rotated ? p.y + (w - h) / 2 : p.y,
      rotation_deg: p.rotated ? 90 : 0,
    }));
    const next: PanelDoc = { ...panel, instances: [...panel.instances, ...added] };
    await get().savePanelConfig(next, stackup);
    const placedN = placements.length;
    const overflow = requested > placedN;
    return {
      ok: true,
      messageKey: overflow ? "panel.add.toast.addedOverflow" : "panel.add.toast.addedN",
      params: { name: design.source_name, n: placedN, requested },
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

  addToolingHole: async (xMm, yMm, diameterMm = DEFAULT_TOOLING_DIAMETER_MM) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup) return "";
    const dia = diameterMm > 0 ? diameterMm : DEFAULT_TOOLING_DIAMETER_MM;
    const r = dia / 2;
    const { x, y } = clampToolingHoleCenter(xMm, yMm, r, panel.width_mm, panel.height_mm);
    const id = nextToolingId(panel.tooling_holes);
    const hole: ToolingHole = { id, x_mm: x, y_mm: y, diameter_mm: dia, role: "registration" };
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

  setDrillClassOverride: async (diameterKey, klass) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup) return;
    const next = { ...(panel.drill_class_overrides ?? {}) } as Record<string, DrillClass>;
    if (klass === null) delete next[diameterKey];
    else next[diameterKey] = klass;
    await get().savePanelConfig({ ...panel, drill_class_overrides: next }, stackup);
  },

  addRegistrationSet: async ({ count, marginMm, diameterMm, replace }) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup) return;
    const positions = registrationSetPositions(panel.width_mm, panel.height_mm, marginMm, count);
    // "replace" wipes existing tooling holes; otherwise the set is appended.
    let holes = replace ? [] : [...panel.tooling_holes];
    const r = diameterMm / 2;
    for (const pos of positions) {
      // Keep the whole bore inside the panel, like addToolingHole — a tiny margin
      // with a large diameter would otherwise push the bore past the edge.
      const c = clampToolingHoleCenter(pos.x, pos.y, r, panel.width_mm, panel.height_mm);
      const id = nextToolingId(holes);
      holes = [...holes, { id, x_mm: c.x, y_mm: c.y, diameter_mm: diameterMm, role: "registration" }];
    }
    const next: PanelDoc = { ...panel, tooling_holes: holes };
    await get().savePanelConfig(next, stackup);
  },

  addAutoFiducials: async (params, replace) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup) return;
    const positions = placeFiducials(panel.width_mm, panel.height_mm, params);
    let holes = replace ? [] : [...panel.tooling_holes];
    const r = params.diameter_mm / 2;
    for (const pos of positions) {
      const c = clampToolingHoleCenter(pos.x_mm, pos.y_mm, r, panel.width_mm, panel.height_mm);
      const id = nextToolingId(holes);
      holes = [...holes, { id, x_mm: c.x, y_mm: c.y, diameter_mm: params.diameter_mm, role: "registration" }];
    }
    const next: PanelDoc = { ...panel, tooling_holes: holes, fiducial_params: params };
    await get().savePanelConfig(next, stackup);
  },

  addKeepOutZone: async ({ x_mm, y_mm, width_mm, height_mm }) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup) return "";
    const { x_mm: cx, y_mm: cy, width_mm: cw, height_mm: ch } =
      clampZoneRect({ x_mm, y_mm, width_mm, height_mm }, panel.width_mm, panel.height_mm, KEEPOUT_MIN_MM);
    const id = crypto.randomUUID();
    const zone: KeepOutZone = { id, x_mm: cx, y_mm: cy, width_mm: cw, height_mm: ch };
    const next: PanelDoc = { ...panel, keep_out_zones: [...(panel.keep_out_zones ?? []), zone] };
    await get().savePanelConfig(next, stackup);
    return id;
  },

  resizeKeepOutZone: async (id, rect) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup) return;
    const clamped = clampZoneRect(rect, panel.width_mm, panel.height_mm, KEEPOUT_MIN_MM);
    const next: PanelDoc = {
      ...panel,
      keep_out_zones: (panel.keep_out_zones ?? []).map((z) => (z.id === id ? { ...z, ...clamped } : z)),
    };
    await get().savePanelConfig(next, stackup);
  },

  moveKeepOutZones: async (ids, dxMm, dyMm) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup || ids.length === 0 || (dxMm === 0 && dyMm === 0)) return;
    const sel = new Set(ids);
    const next: PanelDoc = {
      ...panel,
      keep_out_zones: (panel.keep_out_zones ?? []).map((z) => {
        if (!sel.has(z.id)) return z;
        // Clamp so the whole zone stays inside the panel.
        const nx = Math.max(0, Math.min(z.x_mm + dxMm, panel.width_mm - z.width_mm));
        const ny = Math.max(0, Math.min(z.y_mm + dyMm, panel.height_mm - z.height_mm));
        return { ...z, x_mm: nx, y_mm: ny };
      }),
    };
    await get().savePanelConfig(next, stackup);
  },

  removeKeepOutZones: async (ids) => {
    const panel = get().currentManifest?.panel;
    const stackup = get().currentManifest?.stackup;
    if (!panel || !stackup || ids.length === 0) return;
    const sel = new Set(ids);
    const next: PanelDoc = {
      ...panel,
      keep_out_zones: (panel.keep_out_zones ?? []).filter((z) => !sel.has(z.id)),
    };
    await get().savePanelConfig(next, stackup);
  },

  _mirrorManifest: async (manifest) => {
    // Keep the working-dir's loose manifest.json in sync with the in-memory
    // manifest after any mutation (basis for crash recovery; Phase 1 still also
    // persists to .cuprum via the existing commands).
    const { workingDir } = get();
    if (workingDir) await api.writeWorkingManifest(workingDir, manifest);
  },

  // Persist a manifest as the live document: working-dir loose file (instant)
  // + repack the .cuprum (autosave). No-op without an open project.
  _persistManifest: async (manifest) => {
    const { workingDir, currentPath } = get();
    if (!workingDir || !currentPath) return;
    await api.writeWorkingManifest(workingDir, manifest);
    await serializePack(() => api.saveProject(workingDir, currentPath));
  },

  // Set the manifest as the live document WITHOUT recording undo, then persist it
  // through the same working-dir + autosave path. This is the single cross-store
  // "handle" `useHistory` uses to apply an undo/redo/restore target — its prior
  // form was an inline `set({ currentManifest }) + _persistManifest` in undo/redo.
  _applyManifest: async (manifest) => {
    set({ currentManifest: manifest });
    // Bump docNonce in the same sync tick, right after the manifest swap, so
    // editors keyed on docNonce always re-sync against the NEW manifest (the old
    // code set currentManifest + docNonce atomically; manifest-first preserves that).
    useHistory.getState()._bumpDocNonce();
    await get()._persistManifest(manifest);
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
    useArtifacts.setState((s) => ({ importingCount: s.importingCount + paths.length }));
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
          // Re-read the live manifest after ALL async imports so concurrent
          // mutations (e.g. a panel edit committing mid-import) are not lost,
          // and undo restores the state just before this commit.
          const base = get().currentManifest ?? prev;
          const manifest: Manifest = { ...base, designs: [...base.designs, ...added] };
          useHistory.getState().recordUndo(base);
          set({ currentManifest: manifest });
      useNavigation.getState().setError(null);
          // Stash trace tokens for the freshly-imported designs (artifact store).
          if (Object.keys(newTraceSessions).length > 0) {
            useArtifacts.setState((s) => ({
              traceSessions: { ...s.traceSessions, ...newTraceSessions },
            }));
          }
          // Persist: write the loose manifest then repack the .cuprum so the freshly
          // copied gerbers land in the container too.
          await get()._persistManifest(manifest);
        }
      } catch (e) {
        failure = failure ?? e;
      }
      if (failure) useNavigation.getState().setError(String(failure));
    } finally {
      useArtifacts.setState((s) => ({ importingCount: Math.max(0, s.importingCount - paths.length) }));
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
      useHistory.getState().recordUndo(prev);
      set({ currentManifest: manifest });
      useNavigation.getState().setError(null);
      await get()._persistManifest(manifest);
    } catch (e) {
      useNavigation.getState().setError(String(e));
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
      useHistory.getState().recordUndo(prev);
      set({ currentManifest: manifest });
      useNavigation.getState().setError(null);
      await get()._persistManifest(manifest);
    } catch (e) {
      useNavigation.getState().setError(String(e));
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
      useHistory.getState().recordUndo(prev);
      set({ currentManifest: manifest });
      useNavigation.getState().setError(null);
      await get()._persistManifest(manifest);
    } catch (e) {
      useNavigation.getState().setError(String(e));
    }
  },
}));

// Persist the open project path + current view so a webview reload or app
// restart can restore exactly what was on screen (consumed by App's cold-start
// restore via lib/lastSession). Fires on every state change but only writes when
// path or view actually changes, so artifact/progress churn doesn't hit storage.
//
// Gated on `_persistArmed`: persistence is DISABLED until the main window calls
// armSessionPersist() at the END of its cold-start restore. This is essential —
// the store is a singleton imported by every window, and during startup many
// unrelated mutations fire while no project is loaded yet (loadDisplayScale,
// loadRecents, …). Without the gate, the first such mutation would run with the
// default home/null state and clear the saved entry (saveLastSession removes it
// on the empty default) BEFORE restore could read it — and secondary windows
// (drill/console/add-design), which share this origin's localStorage but never
// run restore, would clobber it too. Only the main window arms the gate, and
// only after restore, so writes thereafter reflect real user navigation.
let _persistArmed = false;
let _lastPersistKey = "";
let _persistScheduled = false;

/** Enable last-session persistence. Called once by the main window after its
 *  cold-start restore completes; never by secondary windows. */
export function armSessionPersist(): void {
  _persistArmed = true;
}

// `currentPath` lives in `useShell`, `view` in `useNavigation` — persist on a
// change to EITHER. The write is coalesced to a microtask so an action that
// mutates both stores (e.g. openProjectByPath sets currentPath then view) lands
// a single write reflecting the FINAL pair, never a transient intermediate —
// matching the old single-atomic-`set` behaviour. The key gate then dedups so
// the effective (path, view) pair only writes once per real change.
function flushPersist(): void {
  _persistScheduled = false;
  if (!_persistArmed) return;
  const path = useShell.getState().currentPath;
  const view = useNavigation.getState().view;
  const key = `${path ?? ""} ${view}`;
  if (key === _lastPersistKey) return;
  _lastPersistKey = key;
  saveLastSession({ path, view });
}

function persistLastSession(): void {
  if (_persistScheduled) return;
  _persistScheduled = true;
  queueMicrotask(flushPersist);
}

useShell.subscribe(persistLastSession);
useNavigation.subscribe(persistLastSession);
