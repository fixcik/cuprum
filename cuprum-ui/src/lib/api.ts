import { invoke as rawInvoke, Channel } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { type NestSettings } from "@/lib/nest";
import type { DrillStep } from "@/lib/drillGcode";
import type { CncProfile } from "@/lib/cncProfile";
import type { Tool } from "@/lib/toolLibrary";

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

/** Class of a drill hole. Mirrors the Rust `DrillClass`. */
export type DrillClass = "registration" | "pth" | "npth" | "mechanical";

/** Overall panel feasibility verdict. Matches `Verdict` in `feasibility.ts`. */
export type Verdict = "ok" | "warn" | "block";

export type MachineStateName =
  | "idle" | "run" | "hold" | "jog" | "alarm" | "home" | "door" | "check" | "sleep" | "unknown";

/** Active limit/probe pins from the GRBL `Pn:` status field (machine.rs `Pins`).
 *  All-false when no pin is engaged. */
export interface Pins {
  x: boolean;
  y: boolean;
  z: boolean;
  probe: boolean;
}

export interface MachineStatus {
  state: MachineStateName;
  mpos: [number, number, number];
  wpos: [number, number, number];
  feed: number;
  spindle: number;
  /** Override percentages [feed, rapid, spindle]; defaults to 100 % each. */
  overrides?: [number, number, number];
  /** Active limit/probe pins; defaults to all-false when absent. */
  pins?: Pins;
}

/** Payload of the global `machine://status` event (machine.rs `MachinePos`).
 *  Full status (not just position) so a follower window (drill) has parity with
 *  the main window's per-connection Channel. */
export interface MachineStatusEvent {
  state: MachineStateName;
  mpos: [number, number, number];
  wpos: [number, number, number];
  feed: number;
  spindle: number;
  /** Override percentages [feed, rapid, spindle]. */
  overrides: [number, number, number];
  /** Active limit/probe pins. */
  pins: Pins;
}

/** A console line as stored in the UI: monotonic sequence number, direction,
 *  text, and the local arrival time (epoch ms, stamped front-side in `pushLine`). */
export interface ConsoleLine {
  /** Monotonic counter assigned on push; used as the delta relay key and React key. */
  seq: number;
  dir: "rx" | "tx";
  text: string;
  ts: number;
}

/** Telemetry over the connect Channel. Matches `Telemetry` in machine.rs.
 *  The "line" payload has no timestamp — it's stamped when stored. */
export type Telemetry =
  | ({ type: "status" } & MachineStatus)
  | { type: "line"; dir: "rx" | "tx"; text: string };

export interface SerialPortInfo {
  name: string;
  kind: string;
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
  /** Cached panel verdict ("ok"/"warn"/"block"); null until first computed. */
  panel_verdict: Verdict | null;
  /** Hash of the capability profile used to compute panel_verdict; null until set. */
  profile_hash: string | null;
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

export type ToolingHoleRole = "registration" | "flip" | "unused";

export interface KeepOutZone {
  id: string;
  x_mm: number;
  y_mm: number;
  width_mm: number;
  height_mm: number;
}

export interface BoardInstance {
  id: string;
  design_id: string;
  x_mm: number;
  y_mm: number;
  rotation_deg: number;
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
  keep_out_zones: KeepOutZone[];
  drill_class_overrides: Record<string, DrillClass>;
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

/** Snapshot pushed from the main window to every inspector window. One channel
 *  for all inspector windows; each picks its design out of `manifest.designs`. */
export interface InspectorSnapshot {
  workingDir: string | null;
  currentPath: string | null;
  manifest: Manifest | null;
}

/** Snapshot pushed from the main window to the add-design window. */
export interface AddDesignSnapshot {
  workingDir: string | null;
  currentPath: string | null;
  designs: ProjectDesign[];
  panel: { widthMm: number; heightMm: number };
  /** When set, the add-design window selects this design on receipt (one-shot,
   *  carried only by the ready-driven snapshot). */
  preselectDesignId?: string | null;
  /** Instances already on the panel (so the preview can avoid them). */
  instances: BoardInstance[];
  /** Board extent (mm) per placed design_id, for drawing/avoiding existing instances. */
  placedSizes: Record<string, { w: number; h: number }>;
  /** Tooling holes on the panel (so the preview avoids them and shows them). */
  tooling_holes: ToolingHole[];
  /** Keep-out zones on the panel (so the board packer avoids them). */
  keep_out_zones: KeepOutZone[];
}
/** Result of an add-to-panel intent, sent back to the add-design window. */
export interface AddDesignResult {
  ok: boolean;
  messageKey: string;
  params?: Record<string, unknown>;
}

/** Data needed to build the drill plan plus the shop settings (CNC profile,
 *  tools, DFM thresholds). Built from the main-window stores by useDrillScreenData
 *  (in the drill bridge) and pushed over IPC to the drill window. */
export interface DrillSnapshot {
  workingDir: string | null;
  /** The saved `.cuprum` path (project identity), or null for an unsaved project.
   *  Used to key the operation-run journal; logging is skipped when null. */
  currentPath: string | null;
  manifest: Manifest | null;
  /** Board extent (mm) per placed design_id; needed for panel drill plan. */
  placedSizes: Record<string, { w: number; h: number }>;
  /** CNC machine profile (safe-Z, spindle, g-code wrappers, …). */
  cncProfile: CncProfile;
  /** Shop tool library (drill diameters / rpm / plunge). */
  tools: Tool[];
  /** DFM thresholds used to classify/snap drill holes. */
  viaMaxDiameterMm: number;
  drillBitToleranceMm: number;
}

/** One journalled operation run (catalog `operation_runs`). Op-agnostic — drill is
 *  the first writer; `params_json`/`summary_json` hold op-specific detail. */
export interface OperationRun {
  runUid: string;
  projectPath: string;
  opType: string;
  startedAt: number;
  /** null while the run is in progress. */
  endedAt: number | null;
  /** null while in progress; "completed" | "stopped" | "error". */
  outcome: string | null;
  /** Total work units (holes/layers/lines); null when not applicable. */
  progressTotal: number | null;
  progressDone: number;
  paramsJson: string;
  summaryJson: string | null;
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
    /** X coordinate of the board outline bounding-box min corner (mm). */
    originXMm: number;
    /** Y coordinate of the board outline bounding-box min corner (mm). */
    originYMm: number;
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

export interface DrillRunProgress {
  holesCompleted: number;
  holesTotal: number;
  holeIndex: number;
  stepIndex: number;
}

export interface DrillRunToolChange {
  toolName: string;
  diameterMm: number;
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
  /** Store the panel verdict + profile hash for a project in the recents catalog.
   *  Does NOT touch last_opened_at or stat columns. Silently no-ops when the path
   *  isn't in the catalog. */
  setRecentVerdict: (path: string, verdict: Verdict, profileHash: string) =>
    invoke<void>("set_recent_verdict", { path, verdict, profileHash }),
  updateProjectMetadata: (path: string, name: string, description: string) =>
    invoke<Manifest>("update_project_metadata", { path, name, description }),
  /** Read a project's manifest straight from its `.cuprum` file (no working dir) —
   *  used to prefill the recents edit dialog for a project that isn't open. */
  readProjectManifest: (path: string) => invoke<Manifest>("read_project_manifest", { path }),
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

  /** Open (or focus) the "Add design to panel" child window. */
  openAddDesignWindow: () => invoke<void>("open_add_design_window"),
  /** Open (or focus) the inspector window for a design (label `inspector-<id>`). */
  openInspectorWindow: (designId: string) => invoke<void>("open_inspector_window", { designId }),
  /** Open (or focus) the drilling-operation window (label `drill`). Resolves `true`
   *  if the window already existed (was focused), `false` if freshly created — used
   *  to route a "repeat run" prefill (emit now vs. hand off as a pending one-shot). */
  openDrillWindow: () => invoke<boolean>("open_drill_window"),
  /** Open (or focus) the machine console OS window. */
  openConsoleWindow: () => invoke<void>("open_console_window"),

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
  /** Subscribe to the native menu's "Check for Updates…" item. */
  onMenuCheckUpdates: (cb: () => void): Promise<UnlistenFn> =>
    listen("menu://check-updates", () => cb()),
  pickProjectFile: () =>
    open({ multiple: false, filters: [{ name: "Cuprum", extensions: ["cu", "cuprum"] }] }) as Promise<
      string | null
    >,
  pickSavePath: (defaultName: string) =>
    save({ defaultPath: defaultName, filters: [{ name: "Cuprum", extensions: ["cu", "cuprum"] }] }),

  // Add-design window bridge events (main ↔ add-design window).
  emitAddDesignReady: () => emit("add-design:ready"),
  onAddDesignReady: (cb: () => void): Promise<UnlistenFn> =>
    listen("add-design:ready", () => cb()),
  emitAddDesignSnapshot: (s: AddDesignSnapshot) => emit("add-design:snapshot", s),
  onAddDesignSnapshot: (cb: (s: AddDesignSnapshot) => void): Promise<UnlistenFn> =>
    listen<AddDesignSnapshot>("add-design:snapshot", (e) => cb(e.payload)),
  emitAddDesignImport: (paths: string[]) => emit("add-design:import", { paths }),
  onAddDesignImport: (cb: (p: { paths: string[] }) => void): Promise<UnlistenFn> =>
    listen<{ paths: string[] }>("add-design:import", (e) => cb(e.payload)),
  emitAddDesignAddToPanel: (designId: string, nest: NestSettings) =>
    emit("add-design:add-to-panel", { designId, nest }),
  onAddDesignAddToPanel: (cb: (p: { designId: string; nest: NestSettings }) => void): Promise<UnlistenFn> =>
    listen<{ designId: string; nest: NestSettings }>("add-design:add-to-panel", (e) => cb(e.payload)),
  emitAddDesignResult: (r: AddDesignResult) => emit("add-design:result", r),
  onAddDesignResult: (cb: (r: AddDesignResult) => void): Promise<UnlistenFn> =>
    listen<AddDesignResult>("add-design:result", (e) => cb(e.payload)),
  emitInspectorReady: () => emit("inspector:ready"),
  onInspectorReady: (cb: () => void): Promise<UnlistenFn> =>
    listen("inspector:ready", () => cb()),
  emitInspectorSnapshot: (s: InspectorSnapshot) => emit("inspector:snapshot", s),
  onInspectorSnapshot: (cb: (s: InspectorSnapshot) => void): Promise<UnlistenFn> =>
    listen<InspectorSnapshot>("inspector:snapshot", (e) => cb(e.payload)),
  emitInspectorRename: (designId: string, name: string) =>
    emit("inspector:rename", { designId, name }),
  onInspectorRename: (cb: (p: { designId: string; name: string }) => void): Promise<UnlistenFn> =>
    listen<{ designId: string; name: string }>("inspector:rename", (e) => cb(e.payload)),
  emitInspectorSetLayerType: (designId: string, path: string, type: LayerType) =>
    emit("inspector:set-layer-type", { designId, path, type }),
  onInspectorSetLayerType: (
    cb: (p: { designId: string; path: string; type: LayerType }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ designId: string; path: string; type: LayerType }>(
      "inspector:set-layer-type",
      (e) => cb(e.payload),
    ),
  emitInspectorArtifactsFresh: (fresh: boolean) => emit("inspector:artifacts-fresh", { fresh }),
  onInspectorArtifactsFresh: (cb: (p: { fresh: boolean }) => void): Promise<UnlistenFn> =>
    listen<{ fresh: boolean }>("inspector:artifacts-fresh", (e) => cb(e.payload)),

  // Drill window bridge events (main → drill window). The drill window is a remote
  // control: it gets the project as a snapshot, follows the machine via the global
  // `machine://status` broadcast (it does NOT take the telemetry Channel), and sends
  // machine/run commands directly via invoke. The only JS-derived machine field not
  // in the backend broadcast — `homed` — is relayed here.
  emitDrillReady: () => emit("drill:ready"),
  onDrillReady: (cb: () => void): Promise<UnlistenFn> =>
    listen("drill:ready", () => cb()),
  emitDrillSnapshot: (s: DrillSnapshot) => emit("drill:snapshot", s),
  onDrillSnapshot: (cb: (s: DrillSnapshot) => void): Promise<UnlistenFn> =>
    listen<DrillSnapshot>("drill:snapshot", (e) => cb(e.payload)),
  /** Main → drill window: prefill the editor with a past run's params_json ("repeat
   *  run"). Overrides the default last-run prefill. */
  emitDrillPrefill: (paramsJson: string) => emit("drill:prefill", { paramsJson }),
  onDrillPrefill: (cb: (paramsJson: string) => void): Promise<UnlistenFn> =>
    listen<{ paramsJson: string }>("drill:prefill", (e) => cb(e.payload.paramsJson)),
  /** Relay the main window's JS-derived machine flags (homed) to the drill window. */
  emitMachineDerived: (d: { homed: boolean }) => emit("machine://derived", d),
  onMachineDerived: (cb: (d: { homed: boolean }) => void): Promise<UnlistenFn> =>
    listen<{ homed: boolean }>("machine://derived", (e) => cb(e.payload)),
  /** Drill window → main: reclassify a drill diameter (project mutation). */
  emitDrillSetClassOverride: (diameterKey: string, klass: DrillClass | null) =>
    emit("drill:set-class-override", { diameterKey, klass }),
  onDrillSetClassOverride: (
    cb: (p: { diameterKey: string; klass: DrillClass | null }) => void,
  ): Promise<UnlistenFn> =>
    listen<{ diameterKey: string; klass: DrillClass | null }>(
      "drill:set-class-override",
      (e) => cb(e.payload),
    ),
  // Console window bridge events (main <-> console).
  emitConsoleReady: () => emit("console:ready"),
  onConsoleReady: (cb: () => void): Promise<UnlistenFn> => listen("console:ready", () => cb()),
  emitConsoleClosed: () => emit("console:closed"),
  onConsoleClosed: (cb: () => void): Promise<UnlistenFn> => listen("console:closed", () => cb()),

  // Intents console -> main (connect/disconnect/home requests from the console window,
  // executed by the main window which owns the serial Channel).
  emitConsoleConnect: (port: string, baud: number) => emit("console:connect", { port, baud }),
  onConsoleConnect: (cb: (p: { port: string; baud: number }) => void): Promise<UnlistenFn> =>
    listen<{ port: string; baud: number }>("console:connect", (e) => cb(e.payload)),
  emitConsoleDisconnect: () => emit("console:disconnect"),
  onConsoleDisconnect: (cb: () => void): Promise<UnlistenFn> =>
    listen("console:disconnect", () => cb()),
  emitConsoleHome: () => emit("console:home"),
  onConsoleHome: (cb: () => void): Promise<UnlistenFn> => listen("console:home", () => cb()),

  /** Apply localised native-menu labels (called on mount and on language change). */
  setAppMenu: (labels: MenuLabels): Promise<void> => invoke("set_app_menu", { labels }),

  machine: {
    listPorts: () => invoke<SerialPortInfo[]>("list_serial_ports"),
    connect: (port: string, baud: number, telemetry: Channel<Telemetry>) =>
      invoke<void>("machine_connect", { port, baud, telemetry }),
    /** Re-bind a fresh telemetry Channel to a connection the backend kept alive
     *  across a webview reload. Returns the held port, or null if nothing is
     *  connected (machine.rs `machine_reattach`). */
    reattach: (telemetry: Channel<Telemetry>) =>
      invoke<{ port: string } | null>("machine_reattach", { telemetry }),
    /** Fetch the in-memory ring buffer of recent console lines (up to 500 entries).
     *  Returns the raw backend payload {dir, text}; the caller stamps seq/ts. */
    consoleBacklog: () =>
      invoke<{ dir: "rx" | "tx"; text: string }[]>("machine_console_backlog"),
    /** Subscribe to `machine://line` global broadcasts (one line per event).
     *  Returns a promise that resolves to an unlisten function. */
    onLine: (cb: (line: { dir: "rx" | "tx"; text: string }) => void): Promise<import("@tauri-apps/api/event").UnlistenFn> =>
      listen<{ dir: "rx" | "tx"; text: string }>("machine://line", (e) => cb(e.payload)),
    disconnect: () => invoke<void>("machine_disconnect"),
    jog: (dx: number, dy: number, dz: number, feed: number) =>
      invoke<void>("machine_jog", { dx, dy, dz, feed }),
    /** Absolute jog (work coords) to the given axis targets; omitted axes hold. */
    jogTo: (target: { x?: number; y?: number; z?: number }, feed: number) =>
      invoke<void>("machine_jog_to", {
        x: target.x ?? null,
        y: target.y ?? null,
        z: target.z ?? null,
        feed,
      }),
    jogCancel: () => invoke<void>("machine_jog_cancel"),
    setZero: (x: boolean, y: boolean, z: boolean) => invoke<void>("machine_set_zero", { x, y, z }),
    home: () => invoke<void>("machine_home"),
    /** Home and resolve only when the cycle completes (ok) or rejects
     *  (error/ALARM/abort) — lets the UI show progress through silent homing. */
    homeAwait: () => invoke<void>("machine_home_await"),
    unlock: () => invoke<void>("machine_unlock"),
    softReset: () => invoke<void>("machine_soft_reset"),
    feedHold: () => invoke<void>("machine_feed_hold"),
    cycleStart: () => invoke<void>("machine_cycle_start"),
    override: (
      kind: "feed" | "rapid" | "spindle",
      action: "100" | "+10" | "-10" | "+1" | "-1" | "stop",
    ) => invoke<void>("machine_override", { kind, action }),
    spindle: (on: boolean, rpm: number) => invoke<void>("machine_spindle", { on, rpm }),
    /** Probe Z onto the work surface and set the G54 Z-zero at contact, then retract
     *  to safe Z. Rejects (Err) on no contact / ALARM — the caller leaves Z unset. */
    probeZ: (maxDistMm: number, feedMmMin: number, offsetMm: number, safeZMm: number, approachZMm?: number) =>
      invoke<void>("machine_probe_z", { maxDistMm, feedMmMin, offsetMm, safeZMm, approachZMm: approachZMm ?? null }),
    send: (line: string) => invoke<void>("machine_send", { line }),
    /** Write a line and reject if GRBL answers error/ALARM — used for firmware
     *  settings writes whose acceptance the UI must confirm. */
    sendAwaitOk: (line: string) => invoke<void>("machine_send_await_ok", { line }),
    onConnected: (cb: () => void): Promise<UnlistenFn> => listen("machine://connected", () => cb()),
    onDisconnected: (cb: () => void): Promise<UnlistenFn> => listen("machine://disconnected", () => cb()),
    onError: (cb: (msg: string) => void): Promise<UnlistenFn> =>
      listen<string>("machine://error", (e) => cb(e.payload)),
    onStatus: (cb: (s: MachineStatusEvent) => void): Promise<UnlistenFn> =>
      listen<MachineStatusEvent>("machine://status", (e) => cb(e.payload)),
    /** Fired (global) whenever unlock ($X) is sent from any window — lets alarm
     *  banners optimistically hide before the next status poll confirms. */
    onUnlock: (cb: () => void): Promise<UnlistenFn> => listen("machine://unlock", () => cb()),
  },

  drillRun: {
    start: (steps: DrillStep[]) => invoke<void>("drill_run_start", { steps }),
    /** Current run status, for a window opening/reopening mid-run (re-attach).
     *  `active` false when no run is live; `phase` is derived from control flags. */
    status: () => invoke<{ active: boolean; phase: string }>("drill_run_status"),
    pause: () => invoke<void>("drill_run_pause"),
    resume: () => invoke<void>("drill_run_resume"),
    stop: () => invoke<void>("drill_run_stop"),
    estop: () => invoke<void>("drill_run_estop"),
    confirmToolChange: () => invoke<void>("drill_run_confirm_tool_change"),
    isConnected: () => invoke<boolean>("machine_is_connected"),
    onState: (cb: (phase: string) => void): Promise<UnlistenFn> =>
      listen<{ phase: string }>("drill-run://state", (e) => cb(e.payload.phase)),
    onProgress: (cb: (p: DrillRunProgress) => void): Promise<UnlistenFn> =>
      listen<DrillRunProgress>("drill-run://progress", (e) => cb(e.payload)),
    onToolChange: (cb: (p: DrillRunToolChange) => void): Promise<UnlistenFn> =>
      listen<DrillRunToolChange>("drill-run://toolchange", (e) => cb(e.payload)),
    onError: (cb: (msg: string) => void): Promise<UnlistenFn> =>
      listen<{ message: string }>("drill-run://error", (e) => cb(e.payload.message)),
    onDone: (cb: () => void): Promise<UnlistenFn> => listen("drill-run://done", () => cb()),
  },

  /** Operation-run journal (catalog DB). Op-agnostic — drill is the first writer.
   *  Logging is best-effort: callers fire-and-forget and must not let a failure
   *  block or abort the real operation. */
  operationLog: {
    /** Record a launched run (backend stamps started_at). */
    start: (p: {
      runUid: string;
      projectPath: string;
      opType: string;
      progressTotal: number | null;
      paramsJson: string;
    }) => invoke<void>("operation_run_log_start", p),
    /** Finalize a run (backend stamps ended_at). */
    finish: (
      runUid: string,
      outcome: "completed" | "stopped" | "error",
      progressDone: number,
      summaryJson?: string | null,
    ) =>
      invoke<void>("operation_run_log_finish", {
        runUid,
        outcome,
        progressDone,
        summaryJson: summaryJson ?? null,
      }),
    /** List a project's runs (newest first), paginated via limit/offset ("load
     *  more"), optionally filtered by op type. */
    list: (projectPath: string, limit: number, offset: number, opType?: string | null) =>
      invoke<OperationRun[]>("operation_runs_list", {
        projectPath,
        opType: opType ?? null,
        limit,
        offset,
      }),
    /** Most recent run's params_json for a project + op type (prefill default). */
    lastParams: (projectPath: string, opType: string) =>
      invoke<string | null>("operation_run_last_params", { projectPath, opType }),
  },
};

/** Labels passed to the native menu; keys match the Rust `MenuLabels` struct. */
export interface MenuLabels {
  edit: string;
  window: string;
  checkUpdates: string;
}
