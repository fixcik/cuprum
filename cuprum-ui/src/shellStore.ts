import { create } from "zustand";
import i18n from "@/i18n";
import { api, type Hole, type LayerGeometry, type LayerType, type Manifest, type PanelDoc, type RecentProject, type StagedFile, type Stackup } from "@/lib/api";
import { isProjectNotFound, projectDisplayName } from "@/lib/projectErrors";

export type View = "home" | "project" | "printer" | "settings" | "import";

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

  // Import wizard
  staged: StagedFile[];
  stagedHoles: Hole[];
  stagedZipPaths: string[];
  stagingError: string | null;
  /** True while the initial fast classify is in flight (before the layer list). */
  staging: boolean;
  /** Bumped on every start/cancel/confirm so late per-layer SVG callbacks from a
   *  superseded import are ignored. */
  importGen: number;
  startImport: () => Promise<void>;
  setLayerType: (index: number, type: LayerType) => void;
  confirmImport: () => Promise<void>;
  cancelImport: () => void;
  /** Private: fill in one staged file's rendered SVG (progressive). */
  _setStagedSvg: (gen: number, index: number, geo: LayerGeometry) => void;
  _setStagedSvgError: (gen: number, index: number, error: string) => void;
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
  pxPerMm: 96 / 25.4,
  _scaleLoaded: false,
  staged: [],
  stagedHoles: [],
  stagedZipPaths: [],
  stagingError: null,
  staging: false,
  importGen: 0,

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
      const name = stem(savePath);
      const manifest = await api.createProject(savePath, name, []);
      set({ currentPath: savePath, currentManifest: manifest, view: "project", error: null });
      await get().loadRecents();
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
    try {
      const manifest = await api.updateProjectMetadata(path, name, description);
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
      const manifest = await api.configurePanel(path, panel, stackup);
      set({ currentManifest: manifest, error: null });
      await get()._mirrorManifest(manifest);
      const { workingDir } = get();
      if (workingDir) await api.writeWorkingPanel(workingDir, panel);
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

  startImport: async () => {
    const zips = await api.pickZips();
    if (!zips || zips.length === 0) return;
    const gen = get().importGen + 1;
    // Open the wizard immediately and show the staging state; the layer list and
    // previews stream in below.
    set({
      importGen: gen,
      staging: true,
      stagingError: null,
      staged: [],
      stagedHoles: [],
      stagedZipPaths: zips,
      view: "import",
    });
    try {
      const cls = await api.stageClassify(zips);
      if (get().importGen !== gen) return; // superseded (cancelled / re-imported)
      const files: StagedFile[] = cls.files.map((f) => ({
        sourceZip: f.sourceZip,
        filename: f.filename,
        layerType: f.layerType,
        svgBody: null,
        bbox: null,
        snap: [],
        error: null,
        holes: f.holes,
        drillError: f.drillError ?? null,
        svgStatus: f.layerType === "drill" ? "none" : "pending",
      }));
      set({ staged: files, stagedHoles: files.flatMap((f) => f.holes), staging: false });
      // Render each layer's SVG in parallel; fill previews in as they resolve.
      files.forEach((f, i) => {
        if (f.svgStatus !== "pending") return;
        api
          .stageLayerSvg(zips, i)
          .then((geo) => get()._setStagedSvg(gen, i, geo))
          .catch((e) => get()._setStagedSvgError(gen, i, String(e)));
      });
    } catch (e) {
      if (get().importGen !== gen) return;
      set({ stagingError: String(e), staging: false });
    }
  },

  _setStagedSvg: (gen, index, geo) =>
    set((s) => {
      if (s.importGen !== gen) return s;
      return {
        staged: s.staged.map((f, i) =>
          i === index ? { ...f, svgBody: geo.svgBody, bbox: geo.bbox, snap: geo.snap, svgStatus: "loaded" } : f,
        ),
      };
    }),

  _setStagedSvgError: (gen, index, error) =>
    set((s) => {
      if (s.importGen !== gen) return s;
      return {
        staged: s.staged.map((f, i) => (i === index ? { ...f, error, svgStatus: "error" } : f)),
      };
    }),

  setLayerType: (index, type) =>
    set((s) => ({
      staged: s.staged.map((f, i) => (i === index ? { ...f, layerType: type } : f)),
    })),

  confirmImport: async () => {
    const { currentPath, staged, stagedZipPaths } = get();
    if (!currentPath) return;
    try {
      // Positional: layer types in staging order, one per staged file.
      const layerTypes = staged.map((f) => f.layerType);
      const manifest = await api.commitImport(currentPath, stagedZipPaths, layerTypes);
      set((s) => ({
        currentManifest: manifest,
        staged: [],
        stagedHoles: [],
        stagedZipPaths: [],
        stagingError: null,
        staging: false,
        importGen: s.importGen + 1,
        view: "project",
      }));
      await get()._mirrorManifest(manifest);
      await get().loadRecents();
    } catch (e) {
      set({ stagingError: String(e) });
    }
  },

  cancelImport: () =>
    set((s) => ({
      staged: [],
      stagedHoles: [],
      stagedZipPaths: [],
      stagingError: null,
      staging: false,
      importGen: s.importGen + 1,
      view: "project",
    })),
}));
