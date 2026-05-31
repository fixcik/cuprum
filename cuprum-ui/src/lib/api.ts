import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";

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

export interface Stackup {
  copper_weight_oz: number;
  substrate_thickness_mm: number;
  double_sided: boolean;
}

export interface PanelDoc {
  schema_version: number;
  width_mm: number;
  height_mm: number;
  origin_x_mm: number;
  origin_y_mm: number;
}

export interface Manifest {
  schema_version: number;
  name: string;
  description: string;
  designs: ProjectDesign[];
  exposure: unknown | null;
  placements: unknown[];
  layer_colors: Record<string, string>;
  stackup: Stackup | null;
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

/** Per-file SVG preview load state during progressive staging.
 *  `none` = no SVG for this file (e.g. a drill layer). */
export type SvgStatus = "pending" | "loaded" | "error" | "none";

export interface StagedFile {
  sourceZip: string;
  filename: string;
  layerType: LayerType;
  svgBody: string | null;
  bbox: BBox | null;
  snap: [number, number][];
  error: string | null;
  /** Drill holes parsed from this file (empty for non-drill files). */
  holes: Hole[];
  /** Set when a drill file carried coordinates we couldn't parse into holes
   *  (distinct from a genuinely empty drill file, where this stays null). */
  drillError: string | null;
  /** Progressive load state of this file's SVG preview. */
  svgStatus: SvgStatus;
}

/** Fast classification result (no SVG yet) from `stage_classify`. */
export interface StagedClassFile {
  sourceZip: string;
  filename: string;
  layerType: LayerType;
  holes: Hole[];
  /** Drill parse error, if the drill body couldn't be understood. */
  drillError: string | null;
}

export interface StagedImport {
  files: StagedFile[];
  holes: Hole[];
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
  openProject: (path: string) => invoke<Manifest>("open_project", { path }),
  importZips: (path: string, zipPaths: string[]) =>
    invoke<Manifest>("import_zips", { path, zipPaths }),
  removeRecent: (path: string) => invoke<void>("remove_recent", { path }),
  updateProjectMetadata: (path: string, name: string, description: string) =>
    invoke<Manifest>("update_project_metadata", { path, name, description }),
  configurePanel: (path: string, panel: PanelDoc, stackup: Stackup) =>
    invoke<Manifest>("configure_panel", { path, panel, stackup }),
  readPanel: (path: string) => invoke<PanelDoc | null>("read_panel", { path }),
  stageImport: (zipPaths: string[]) => invoke<StagedImport>("stage_import", { zipPaths }),
  /** Fast: classify every gerber (names + types + drill holes), no SVG render. */
  stageClassify: (zipPaths: string[]) =>
    invoke<{ files: StagedClassFile[] }>("stage_classify", { zipPaths }),
  /** Render ONE staged layer's SVG by its staging index (call per-layer). */
  stageLayerSvg: (zipPaths: string[], index: number) =>
    invoke<LayerGeometry>("stage_layer_svg", { zipPaths, index }),
  commitImport: (path: string, zipPaths: string[], layerTypes: LayerType[]) =>
    invoke<Manifest>("commit_import", { path, zipPaths, layerTypes }),
  renderGerberSvg: (path: string, gerberRel: string) =>
    invoke<LayerGeometry>("render_gerber_svg", { path, gerberRel }),
  readDrill: (path: string, gerberRel: string) =>
    invoke<Hole[]>("read_drill", { path, gerberRel }),
  copperPolygons: (path: string, gerberRel: string, holes: Hole[]) =>
    invoke<Poly[]>("copper_polygons", { projectPath: path, gerberRel, holes }),
  /** Generic fill layer (copper/silk/paste/other) polygons with drills subtracted. */
  layerPolygons: (path: string, gerberRel: string, holes: Hole[]) =>
    invoke<Poly[]>("layer_polygons", { projectPath: path, gerberRel, holes }),
  /** Soldermask = board outline rings MINUS the mask openings. */
  maskPolygons: (path: string, gerberRel: string, outlineRings: [number, number][][]) =>
    invoke<Poly[]>("mask_polygons", { projectPath: path, gerberRel, outlineRings }),
  /** Full triangulated 3D board mesh for STAGED gerbers (import wizard), as a
   *  binary blob (see lib/boardMesh.ts). `layerTypes` are positional, in staging
   *  order. `excludedKeys` (staging-index strings) drop hidden drill layers so
   *  their holes are removed from the board too. */
  stagedBoardMesh: (zipPaths: string[], layerTypes: LayerType[], excludedKeys: string[] = []) =>
    invoke<ArrayBuffer>("staged_board_mesh", { zipPaths, layerTypes, excludedKeys }),
  /** Measured manufacturing facts (board size, layer inventory, min trace, drill
   *  stats) for STAGED gerbers under the current per-file `layerTypes` (positional,
   *  staging order). The frontend judges these against the capability profile. */
  stagedBoardMetrics: (zipPaths: string[], layerTypes: LayerType[]) =>
    invoke<BoardMetrics>("staged_board_metrics", { zipPaths, layerTypes }),
  /** Full triangulated 3D board mesh for a COMMITTED project, as a binary blob.
   *  `excludedKeys` (gerber-rel strings) drop hidden drill layers. */
  projectBoardMesh: (
    path: string,
    gerbers: { rel: string; layerType: LayerType }[],
    excludedKeys: string[] = [],
  ) => invoke<ArrayBuffer>("project_board_mesh", { projectPath: path, gerbers, excludedKeys }),

  displayPxPerMm: () => invoke<number>("display_px_per_mm"),

  // Dialogs for the project flows.
  pickZips: () =>
    open({ multiple: true, filters: [{ name: "ZIP", extensions: ["zip"] }] }) as Promise<
      string[] | null
    >,
  pickProjectFile: () =>
    open({ multiple: false, filters: [{ name: "Cuprum", extensions: ["cuprum"] }] }) as Promise<
      string | null
    >,
  pickSavePath: (defaultName: string) =>
    save({ defaultPath: defaultName, filters: [{ name: "Cuprum", extensions: ["cuprum"] }] }),
};
