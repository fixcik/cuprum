import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

/** Dev-only IPC tracer. Tauri's `invoke` is NOT HTTP, so command calls never
 *  appear in the browser Network tab — in dev builds we log every command (args,
 *  result/error, timing) to the console instead. Production is a passthrough.
 *  Filter the console by "[ipc]" to see all backend round-trips. */
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!import.meta.env.DEV) return rawInvoke<T>(cmd, args);
  const t0 = performance.now();
  return rawInvoke<T>(cmd, args).then(
    (result) => {
      console.log(`[ipc] ${cmd}  ${(performance.now() - t0).toFixed(0)}ms`, { args, result });
      return result;
    },
    (error) => {
      console.error(`[ipc] ${cmd}  FAILED ${(performance.now() - t0).toFixed(0)}ms`, { args, error });
      throw error;
    },
  );
}

// Physical exposure screen, from cuprum-core (14×19 µm pitch → 211.68 × 118.37 mm).
export const SCREEN_W_MM = 211.68;
export const SCREEN_H_MM = 118.37;

export interface PrinterInfo {
  name: string;
  ip: string;
}

export interface PreviewResult {
  png_data_url: string;
  width_mm: number;
  height_mm: number;
  timings: string;
}

export interface PrintStatus {
  stage: string;
  message: string;
}

export interface PlacementDto {
  path: string;
  x_mm: number;
  y_mm: number;
  rotation_deg: number;
}

export interface PrintRequest {
  placements: PlacementDto[];
  mirror: boolean;
  invert: boolean;
  exposure_s: number;
  pwm: number;
}

export interface RecentProject {
  path: string;
  name: string;
  last_opened_at: number;
  exists: boolean;
  /** Number of designs in the project (Home card footer). 0 until first open/save
   *  for projects catalogued before stats were tracked. */
  design_count: number;
  /** Panel blank size in mm; null until the panel is configured. */
  width_mm: number | null;
  height_mm: number | null;
}

export type LayerType =
  | "topCopper"
  | "bottomCopper"
  | "innerCopper"
  | "topMask"
  | "bottomMask"
  | "topSilk"
  | "bottomSilk"
  | "topPaste"
  | "bottomPaste"
  | "edgeCuts"
  | "drill"
  | "other";

export interface GerberFile {
  path: string;
  layer_type: LayerType;
}

export interface ProjectDesign {
  id: string;
  source_name: string;
  gerbers: GerberFile[];
}

/** Wrapper returned by `add_design_from_zip` after Tasks 1-3: the new design
 *  plus an opaque trace-session token (null when tracing is disabled). */
export interface AddedDesign {
  design: ProjectDesign;
  traceSession: number | null;
}

export interface Stackup {
  copper_weight_oz: number;
  substrate_thickness_mm: number;
  double_sided: boolean;
}

/** FR4 substrate thickness (mm) used for the 3D board when the panel stackup is
 *  not configured. Mirrors `cuprum_core::mesh::DEFAULT_FR4_THICK`. */
export const DEFAULT_FR4_THICKNESS_MM = 1.6;

export type LayerRef = "Top" | "Bottom";
export type ToolingHoleRole = "registration" | "flip" | "unused";

export interface BoardInstance {
  id: string;
  design_id: string;
  x_mm: number;
  y_mm: number;
  rotation_deg: number;
  layer_ref: LayerRef;
}

export interface ToolingHole {
  id: string;
  x_mm: number;
  y_mm: number;
  diameter_mm: number;
  role: ToolingHoleRole;
}

export interface PanelDoc {
  schema_version: number;
  width_mm: number;
  height_mm: number;
  origin_x_mm: number;
  origin_y_mm: number;
  instances: BoardInstance[];
  tooling_holes: ToolingHole[];
}

export interface Manifest {
  schema_version: number;
  name: string;
  description: string;
  designs: ProjectDesign[];
  exposure: unknown | null;
  layer_colors: Record<string, string>;
  stackup: Stackup | null;
  panel: PanelDoc | null;
}

export interface OpenedProject {
  workingDir: string;
  manifest: Manifest;
}

export interface Orphan {
  workdir: string;
  sourcePath: string;
  dirty: boolean;
}

export interface RestorePointMeta {
  id: string;
  label: string | null;
  createdAt: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface LayerGeometry {
  svgBody: string;
  bbox: BBox;
  snap: [number, number][];
}

export interface LayerSvgResult {
  rel: string;
  geometry: LayerGeometry | null;
  error: string | null;
  fresh: boolean;
}

export interface PreviewResultDto {
  pngDataUrl: string;
  fresh: boolean;
}

/** project_board_metrics return: metrics + whether they were freshly computed. */
export interface BoardMetricsResult {
  metrics: BoardMetrics;
  fresh: boolean;
}

export interface Hole {
  x: number;
  y: number;
  d: number;
}

/** Measured manufacturing facts for a board (mirrors `cuprum_core::metrics`). */
export interface BoardMetrics {
  board: {
    widthMm: number;
    heightMm: number;
    outlineClosed: boolean;
    cutoutCount: number;
    hasEdgeLayer: boolean;
  };
  layers: {
    copperTop: boolean;
    copperBottom: boolean;
    innerCopperCount: number;
    hasMaskTop: boolean;
    hasMaskBottom: boolean;
    hasSilkTop: boolean;
    hasSilkBottom: boolean;
    hasPaste: boolean;
    copperLayerCount: number;
  };
  copper: { side: "top" | "bottom" | "inner"; minTraceMm: number | null; traceWidthsMm: number[]; primitiveCount: number }[];
  drill: {
    totalHoles: number;
    uniqueToolDiametersMm: number[];
    minHoleMm: number | null;
    platedHoleCount: number;
    nonplatedHoleCount: number;
    diameterHistogram: [number, number][];
  };
  /** Geometric measurements (Phase 2/3). Null when the layer is absent or the
   *  value is outside the DRC-relevant range (i.e. comfortably fine). */
  geo: {
    copperCoveragePct: number | null;
    minSilkLineMm: number | null;
    /** Distinct silk stroke widths (sorted asc); frontend drops sub-artefact ones. */
    silkLineWidthsMm: number[];
    minClearanceMm: number | null;
    minCopperWidthMm: number | null;
    minAnnularMm: number | null;
    minMaskDamMm: number | null;
    layerOvershootMm: number | null;
    slotCount: number;
    minSlotWidthMm: number | null;
    /** Located issues (worst-first) for preview markers. */
    clearanceHotspots: GeoHotspot[];
    copperWidthHotspots: GeoHotspot[];
    thinTraceConductors: GeoHotspot[];
    traceCount: number;
    traceTotalLengthMm: number;
    annularHotspots: GeoHotspot[];
    maskDamHotspots: GeoHotspot[];
    overshootHotspots: GeoHotspot[];
    /** Thin-feature locations (stroke endpoints + width) for box markers. */
    silkHotspots: GeoHotspot[];
    traceHotspots: GeoHotspot[];
    /** Drill-hole locations (bbox + diameter) for box markers. */
    drillHotspots: GeoHotspot[];
  };
}

/** One located DFM issue: two closest mm points + the measured value (mm).
 *  `side` is the 2D face it lives on ("both" for through-features like holes),
 *  so the preview hides markers for the face that isn't being viewed. */
export interface GeoHotspot {
  a: [number, number];
  b: [number, number];
  v: number;
  side: "top" | "bottom" | "both";
}

/** A clean simple polygon: one outer ring plus zero or more hole rings, in
 *  absolute mm (Y up). Computed by the Rust core for copper layers. */
export interface Poly {
  outer: [number, number][];
  holes: [number, number][][];
}

export const api = {
  discover: () => invoke<PrinterInfo>("discover"),
  renderPreview: async (path: string, maxPx = 2600) => {
    const t0 = performance.now();
    const r = await invoke<PreviewResult>("render_preview", { path, maxPx });
    console.log(`[render_preview] ${r.timings} | round-trip ${(performance.now() - t0).toFixed(0)}ms`);
    return r;
  },
  composeAndPrint: (req: PrintRequest) => invoke<void>("compose_and_print", { req }),
  stopPrint: () => invoke<void>("stop_print"),
  onPrintStatus: (cb: (s: PrintStatus) => void): Promise<UnlistenFn> =>
    listen<PrintStatus>("print-status", (e) => cb(e.payload)),
  pickGerber: () =>
    open({
      multiple: false,
      filters: [{ name: "Gerber", extensions: ["gbr", "grb", "ger", "gtl", "gbl"] }],
    }) as Promise<string | null>,

  listRecentProjects: () => invoke<RecentProject[]>("list_recent_projects"),
  createProject: (savePath: string, name: string, zipPaths: string[]) =>
    invoke<Manifest>("create_project", { savePath, name, zipPaths }),
  openProject: (path: string) => invoke<OpenedProject>("open_project", { path }),
  saveProject: (workingDir: string, targetPath: string) =>
    invoke<void>("save_project", { workingDir, targetPath }),
  writeWorkingManifest: (workingDir: string, manifest: Manifest) =>
    invoke<void>("write_working_manifest", { workingDir, manifest }),
  scanRecoverable: () => invoke<Orphan[]>("scan_recoverable", {}),
  cleanupWorkdir: (workingDir: string) => invoke<void>("cleanup_workdir", { workingDir }),
  makeRestorePoint: (workingDir: string, label?: string, auto = false) =>
    invoke<RestorePointMeta>("make_restore_point", { workingDir, label: label ?? null, auto }),
  listRestorePoints: (workingDir: string) =>
    invoke<RestorePointMeta[]>("list_restore_points", { workingDir }),
  readRestorePoint: (workingDir: string, id: string) =>
    invoke<Manifest>("read_restore_point", { workingDir, id }),
  removeRecent: (path: string) => invoke<void>("remove_recent", { path }),
  updateProjectMetadata: (path: string, name: string, description: string) =>
    invoke<Manifest>("update_project_metadata", { path, name, description }),
  /** Read a project's manifest straight from its `.cuprum` file (no working dir) —
   *  used to prefill the recents edit dialog for a project that isn't open. */
  readProjectManifest: (path: string) => invoke<Manifest>("read_project_manifest", { path }),
  configurePanel: (path: string, panel: PanelDoc, stackup: Stackup) =>
    invoke<Manifest>("configure_panel", { path, panel, stackup }),
  /** Copy a source ZIP into the open project's working dir as a new design
   *  (auto-classified) and return it; merge into the manifest + persist via the
   *  autosave path. */
  addDesignFromZip: (workingDir: string, zipPath: string) =>
    invoke<AddedDesign>("add_design_from_zip", { workingDir, zipPath }),
  renderGerberSvg: (workingDir: string, gerberRel: string) =>
    invoke<LayerGeometry>("render_gerber_svg", { workingDir, gerberRel }),
  renderLayersSvg: (workingDir: string, rels: string[], traceSession?: number) =>
    invoke<LayerSvgResult[]>("render_layers_svg", { workingDir, rels, traceSession }),
  renderDesignPreview: (
    workingDir: string,
    designId: string,
    gerbers: { rel: string; layerType: LayerType }[],
    layerColors?: Record<string, string>,
    traceSession?: number,
  ) =>
    invoke<PreviewResultDto>("render_design_preview", {
      workingDir,
      designId,
      gerbers,
      layerColors: layerColors ?? null,
      traceSession,
    }),
  readDrill: (workingDir: string, gerberRel: string) =>
    invoke<Hole[]>("read_drill", { workingDir, gerberRel }),
  copperPolygons: (workingDir: string, gerberRel: string, holes: Hole[]) =>
    invoke<Poly[]>("copper_polygons", { workingDir, gerberRel, holes }),
  /** Generic fill layer (copper/silk/paste/other) polygons with drills subtracted. */
  layerPolygons: (workingDir: string, gerberRel: string, holes: Hole[]) =>
    invoke<Poly[]>("layer_polygons", { workingDir, gerberRel, holes }),
  /** Soldermask = board outline rings MINUS the mask openings. */
  maskPolygons: (workingDir: string, gerberRel: string, outlineRings: [number, number][][]) =>
    invoke<Poly[]>("mask_polygons", { workingDir, gerberRel, outlineRings }),
  /** Full triangulated 3D board mesh for a COMMITTED project, as a binary blob.
   *  `excludedKeys` (gerber-rel strings) drop hidden drill layers. `thicknessMm`
   *  is the FR4 substrate thickness from the panel stackup (bakes the board Z). */
  projectBoardMesh: (
    workingDir: string,
    gerbers: { rel: string; layerType: LayerType }[],
    excludedKeys: string[] = [],
    thicknessMm: number = DEFAULT_FR4_THICKNESS_MM,
  ) =>
    invoke<ArrayBuffer>("project_board_mesh", {
      workingDir,
      gerbers,
      excludedKeys,
      thicknessMm,
    }),
  /** Measured manufacturing facts (DFM) for a committed design read from the
   *  working dir; judged client-side against the capability profile. */
  projectBoardMetrics: (
    workingDir: string,
    gerbers: { rel: string; layerType: LayerType }[],
    traceSession?: number,
  ) => invoke<BoardMetricsResult>("project_board_metrics", { workingDir, gerbers, traceSession }),

  displayPxPerMm: () => invoke<number>("display_px_per_mm"),

  // Dialogs for the project flows.
  pickZips: () =>
    open({ multiple: true, filters: [{ name: "ZIP", extensions: ["zip"] }] }) as Promise<
      string[] | null
    >,
  /** Take (and clear) the project path a double-click/relaunch queued, if any. */
  takePendingOpen: () => invoke<string | null>("take_pending_open"),
  /** Subscribe to live "open this file" events (relaunch / macOS Opened). */
  onOpenFile: (cb: (path: string) => void): Promise<UnlistenFn> =>
    listen<string>("open-file", (e) => cb(e.payload)),
  pickProjectFile: () =>
    open({ multiple: false, filters: [{ name: "Cuprum", extensions: ["cu", "cuprum"] }] }) as Promise<
      string | null
    >,
  pickSavePath: (defaultName: string) =>
    save({ defaultPath: defaultName, filters: [{ name: "Cuprum", extensions: ["cu", "cuprum"] }] }),
};
