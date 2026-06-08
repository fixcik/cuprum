/** Machine model — discriminated union by `kind`.
 *
 *  A Machine is a first-class persisted object that lives in `settingsStore.machines[]`.
 *  The `id` is stable (e.g. "machine-1") and survives edits, following the same
 *  pattern as Tool ids in toolLibrary.ts.
 *
 *  Current kinds:
 *    - "cnc"   — CNC router/mill; carries all CncProfile fields.
 *    - "uvlcd" — UV LCD exposure unit; carries screen dimensions (mm).
 *
 *  Future kinds (laser, etc.) will extend this union without breaking existing
 *  data, following the same discriminated-union pattern. */

/** Fields common to every machine kind. */
interface MachineBase {
  /** Stable identifier — format "machine-<n>", survives edits. */
  id: string;
  name: string;
}

/** CNC router / milling machine.  All fields mirror CncProfile v1.
 *  This is the "kind=cnc" branch of the union; CncProfile fields are
 *  inlined here so consumers can read `machine.port`, `machine.baud`, etc. */
export interface CncMachine extends MachineBase {
  kind: "cnc";
  // --- connection ---
  /** Last-used serial port; null until first connect. */
  port: string | null;
  baud: number;
  // --- jog ---
  jogFeedMmMin: number;
  /** Selectable jog step sizes (mm). */
  jogStepsMm: number[];
  // --- work envelope (mm) ---
  workEnvelopeMm: { x: number; y: number; z: number };
  // --- spindle ---
  spindleMaxRpm: number;
  /** Can we command spindle speed (S word)? Stock 3018 spindle: false. */
  spindleControllable: boolean;
  spindleHasPwm: boolean;
  // --- probe (Z touch-off per tool) ---
  /** Probe feed (mm/min) for the slow G38.2 descent. */
  probeFeedMmMin: number;
  /** Max probe travel down (mm); G38.2 errors if no contact within this. Keep small
   *  so a missed contact (probe not wired) is a gentle nudge, not a crash. */
  probeMaxDistMm: number;
  /** Z offset applied at contact (mm). 0 = clip on copper, contact = board top. A
   *  conductive plate of thickness t under the bit → set t. */
  probePlateOffsetMm: number;
  /** Whether a Z-probe is available (the 3018 shipped with one). Gates the "Probe"
   *  path in the run's per-tool Z step. */
  hasProbe: boolean;
  // --- emission (consumed by G-code emitter) ---
  gcodeDialect: "grbl_1_1";
  /** Work-coordinate safe-Z (mm), used by the drilling G-code emitter for retracts. */
  safeZMm: number;
  /** Machine-coordinate (G53) safe retract height (mm), ≤ 0 (just below the top
   *  limit). Used for safe traverses during manual control so a low work zero
   *  can't drive Z above the top limit switch. */
  machineSafeZMm: number;
  /** Work-coordinate (G54) retract height (mm) for a manual tool change — higher
   *  than safeZMm so there's room to swap the bit. */
  toolChangeZMm: number;
  // --- mechanics (DFM / future compensation) ---
  runoutMm: number;
  backlashMm: { x: number; y: number; z: number };
  // --- free-form G-code wrappers ---
  prependGcode: string;
  appendGcode: string;
  /** Saved work-zero in MACHINE coordinates (XY only), for restore-after-homing.
   *  null until the operator saves it. Z is always set manually (touch-off). */
  workZeroMm: { x: number; y: number } | null;
}

/** UV LCD exposure unit.  Currently carries the physical screen size only;
 *  pixel pitch, exposure settings, etc. will be added in a later workstream (epic #202 §5). */
export interface UvLcdMachine extends MachineBase {
  kind: "uvlcd";
  /** Physical screen width (mm) — matches the former SCREEN_W_MM constant. */
  screenWidthMm: number;
  /** Physical screen height (mm) — matches the former SCREEN_H_MM constant. */
  screenHeightMm: number;
}

export type Machine = CncMachine | UvLcdMachine;

/** Next stable machine id: max existing "machine-N" + 1 (survives deletions). */
export function nextMachineId(machines: Machine[]): string {
  const max = machines.reduce((m, mc) => {
    const n = /^machine-(\d+)$/.exec(mc.id);
    return n ? Math.max(m, Number(n[1])) : m;
  }, 0);
  return `machine-${max + 1}`;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default CNC machine — mirrors DEFAULT_CNC_PROFILE exactly. */
export const DEFAULT_CNC_MACHINE: CncMachine = {
  id: "machine-1",
  kind: "cnc",
  name: "CNC 3018",
  port: null,
  baud: 115200,
  jogFeedMmMin: 500,
  jogStepsMm: [0.1, 1, 10],
  workEnvelopeMm: { x: 300, y: 180, z: 45 },
  spindleMaxRpm: 9000,
  spindleControllable: false,
  spindleHasPwm: true,
  probeFeedMmMin: 50,
  probeMaxDistMm: 8,
  probePlateOffsetMm: 0,
  hasProbe: true,
  gcodeDialect: "grbl_1_1",
  safeZMm: 5,
  machineSafeZMm: -1,
  toolChangeZMm: 20,
  runoutMm: 0.15,
  backlashMm: { x: 0.05, y: 0.1, z: 0.05 },
  prependGcode: "",
  appendGcode: "",
  workZeroMm: null,
};

/** Default UV LCD machine — Elegoo Saturn 4 Ultra 16K screen dimensions.
 *  Values match SCREEN_W_MM / SCREEN_H_MM in api.ts (14×19 µm pitch → 211.68 × 118.37 mm). */
export const DEFAULT_UV_MACHINE: UvLcdMachine = {
  id: "machine-2",
  kind: "uvlcd",
  name: "Saturn 4 Ultra 16K",
  screenWidthMm: 211.68,
  screenHeightMm: 118.37,
};

// ---------------------------------------------------------------------------
// Builders ("add machine" buttons)
// ---------------------------------------------------------------------------

/** A name not yet taken by any machine: `base`, else `base (2)`, `base (3)`, … */
export function uniqueName(machines: Machine[], base: string): string {
  const taken = new Set(machines.map((m) => m.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A fresh default CNC machine with the next id and a unique name. */
export function newCncMachine(machines: Machine[]): CncMachine {
  return {
    ...DEFAULT_CNC_MACHINE,
    id: nextMachineId(machines),
    name: uniqueName(machines, DEFAULT_CNC_MACHINE.name),
  };
}

/** A fresh default UV LCD machine with the next id and a unique name. */
export function newUvMachine(machines: Machine[]): UvLcdMachine {
  return {
    ...DEFAULT_UV_MACHINE,
    id: nextMachineId(machines),
    name: uniqueName(machines, DEFAULT_UV_MACHINE.name),
  };
}

// ---------------------------------------------------------------------------
// Model presets (add-device screen)
// ---------------------------------------------------------------------------

/** A selectable model preset on the add-device screen. `build` produces a fresh
 *  machine (unique id + name) pre-filled from the preset; the caller may then
 *  override the name from the form. `label` is the human model name (also the
 *  default device name), `sub` is the secondary dims line. `custom` marks the
 *  "Своя"/"Custom" fallback, which keeps the kind's DEFAULT envelope/screen. */
export interface MachinePreset {
  id: string;
  label: string;
  sub: string;
  custom?: boolean;
  build: (machines: Machine[]) => Machine;
}

/** Format an envelope as a raw "X × Y × Z" dims string (no unit suffix; the UI
 *  renders it verbatim). */
function dims(x: number, y: number, z: number): string {
  return `${x} × ${y} × ${z}`;
}

/** A CNC preset for a given envelope, named after the model. */
function cncPreset(id: string, label: string, env: { x: number; y: number; z: number }): MachinePreset {
  return {
    id,
    label,
    sub: dims(env.x, env.y, env.z),
    build: (machines) => ({
      ...newCncMachine(machines),
      name: uniqueName(machines, label),
      workEnvelopeMm: { ...env },
    }),
  };
}

/** CNC model presets. Non-custom presets set the work envelope; "Своя" keeps the
 *  DEFAULT_CNC_MACHINE envelope and name for manual configuration afterwards. */
export const CNC_PRESETS: MachinePreset[] = [
  cncPreset("cnc-3018", "CNC 3018", { x: 300, y: 180, z: 45 }),
  cncPreset("cnc-4030", "CNC 4030", { x: 400, y: 300, z: 100 }),
  cncPreset("cnc-6090", "CNC 6090", { x: 600, y: 900, z: 120 }),
  {
    id: "cnc-custom",
    // `label`/`sub` are unused for custom presets — the UI renders a localized
    // "Custom / configure manually" heading instead — but the interface requires
    // them, so leave them empty.
    label: "",
    sub: "",
    custom: true,
    build: (machines) => newCncMachine(machines),
  },
];

/** A UV LCD preset for a given screen size, named after the model. */
function uvPreset(id: string, label: string, screen: { w: number; h: number }): MachinePreset {
  return {
    id,
    label,
    sub: `${screen.w} × ${screen.h}`,
    build: (machines) => ({
      ...newUvMachine(machines),
      name: uniqueName(machines, label),
      screenWidthMm: screen.w,
      screenHeightMm: screen.h,
    }),
  };
}

/** UV LCD model presets. Saturn 4 Ultra uses the existing DEFAULT_UV_MACHINE
 *  screen dimensions; Mars 5 / Sonic Mini screen sizes are real-ish active-area
 *  values for those mono-LCD models (placeholders — refine if exact specs land).
 *  "Своя" keeps the DEFAULT screen for manual configuration afterwards. */
export const UV_PRESETS: MachinePreset[] = [
  uvPreset("uv-saturn4ultra", "Saturn 4 Ultra", {
    w: DEFAULT_UV_MACHINE.screenWidthMm,
    h: DEFAULT_UV_MACHINE.screenHeightMm,
  }),
  // Elegoo Mars 5: ~143 × 89 mm active area (9" mono LCD).
  uvPreset("uv-mars5", "Mars 5", { w: 143, h: 89 }),
  // Phrozen Sonic Mini: ~165 × 72 mm active area (6.1" mono LCD).
  uvPreset("uv-sonicmini", "Sonic Mini", { w: 165, h: 72 }),
  {
    id: "uv-custom",
    // `label`/`sub` unused for custom presets (see CNC custom note above).
    label: "",
    sub: "",
    custom: true,
    build: (machines) => newUvMachine(machines),
  },
];

/** Model presets for a machine kind, in presentation order. */
export function presetsForKind(kind: Machine["kind"]): MachinePreset[] {
  return kind === "cnc" ? CNC_PRESETS : UV_PRESETS;
}

// ---------------------------------------------------------------------------
// Config dirty / factory-reset (cards editor)
// ---------------------------------------------------------------------------

/** Editable CNC config keys shown in the cards editor. Dotted keys address
 *  nested fields (`envelope.*`, `backlash.*`). Order is presentation order. */
export const CNC_CONFIG_KEYS = [
  "envelope.x",
  "envelope.y",
  "envelope.z",
  "spindleMaxRpm",
  "spindleControllable",
  "spindleHasPwm",
  "safeZMm",
  "machineSafeZMm",
  "toolChangeZMm",
  "hasProbe",
  "probeFeedMmMin",
  "probeMaxDistMm",
  "probePlateOffsetMm",
  "runoutMm",
  "backlash.x",
  "backlash.y",
  "backlash.z",
  "baud",
  "prependGcode",
  "appendGcode",
] as const;

export type CncConfigKey = (typeof CNC_CONFIG_KEYS)[number];

/** Read a CNC config key (incl. dotted nested ones) off a machine. */
function cncConfigValue(m: CncMachine, key: CncConfigKey): number | boolean | string {
  switch (key) {
    case "envelope.x":
      return m.workEnvelopeMm.x;
    case "envelope.y":
      return m.workEnvelopeMm.y;
    case "envelope.z":
      return m.workEnvelopeMm.z;
    case "backlash.x":
      return m.backlashMm.x;
    case "backlash.y":
      return m.backlashMm.y;
    case "backlash.z":
      return m.backlashMm.z;
    case "spindleMaxRpm":
      return m.spindleMaxRpm;
    case "spindleControllable":
      return m.spindleControllable;
    case "spindleHasPwm":
      return m.spindleHasPwm;
    case "safeZMm":
      return m.safeZMm;
    case "machineSafeZMm":
      return m.machineSafeZMm;
    case "toolChangeZMm":
      return m.toolChangeZMm;
    case "hasProbe":
      return m.hasProbe;
    case "probeFeedMmMin":
      return m.probeFeedMmMin;
    case "probeMaxDistMm":
      return m.probeMaxDistMm;
    case "probePlateOffsetMm":
      return m.probePlateOffsetMm;
    case "runoutMm":
      return m.runoutMm;
    case "baud":
      return m.baud;
    case "prependGcode":
      return m.prependGcode;
    case "appendGcode":
      return m.appendGcode;
  }
}

/** Config keys whose value differs from the CNC factory default. */
export function cncConfigDirtyKeys(m: CncMachine): Set<string> {
  const dirty = new Set<string>();
  for (const key of CNC_CONFIG_KEYS) {
    if (cncConfigValue(m, key) !== cncConfigValue(DEFAULT_CNC_MACHINE, key)) dirty.add(key);
  }
  return dirty;
}

/** Patch resetting all CNC config fields to factory, preserving identity and
 *  runtime state (id/name/port/workZero/jog/dialect). Apply via updateMachine. */
export function resetCncToFactory(_m: CncMachine): Partial<CncMachine> {
  const d = DEFAULT_CNC_MACHINE;
  return {
    workEnvelopeMm: { ...d.workEnvelopeMm },
    spindleMaxRpm: d.spindleMaxRpm,
    spindleControllable: d.spindleControllable,
    spindleHasPwm: d.spindleHasPwm,
    safeZMm: d.safeZMm,
    machineSafeZMm: d.machineSafeZMm,
    toolChangeZMm: d.toolChangeZMm,
    hasProbe: d.hasProbe,
    probeFeedMmMin: d.probeFeedMmMin,
    probeMaxDistMm: d.probeMaxDistMm,
    probePlateOffsetMm: d.probePlateOffsetMm,
    runoutMm: d.runoutMm,
    backlashMm: { ...d.backlashMm },
    baud: d.baud,
    prependGcode: d.prependGcode,
    appendGcode: d.appendGcode,
  };
}

/** Editable UV LCD config keys shown in the cards editor. */
export const UV_CONFIG_KEYS = ["screenWidthMm", "screenHeightMm"] as const;

export type UvConfigKey = (typeof UV_CONFIG_KEYS)[number];

/** Config keys whose value differs from the UV factory default. */
export function uvConfigDirtyKeys(m: UvLcdMachine): Set<string> {
  const dirty = new Set<string>();
  for (const key of UV_CONFIG_KEYS) {
    if (m[key] !== DEFAULT_UV_MACHINE[key]) dirty.add(key);
  }
  return dirty;
}

/** Patch resetting UV screen size to factory, preserving id/name. */
export function resetUvToFactory(_m: UvLcdMachine): Partial<UvLcdMachine> {
  return {
    screenWidthMm: DEFAULT_UV_MACHINE.screenWidthMm,
    screenHeightMm: DEFAULT_UV_MACHINE.screenHeightMm,
  };
}

/** Validation for the tool-change retract height. Returns a warning key or null.
 *  "below-safe": not above the travel safe-Z (or negative) → no room to swap.
 *  "over-travel": higher than the machine Z travel → unreachable. */
export function toolChangeZWarning(p: {
  safeZMm: number;
  toolChangeZMm: number;
  envZMm: number;
}): "below-safe" | "over-travel" | null {
  if (p.toolChangeZMm < 0 || p.toolChangeZMm < p.safeZMm) return "below-safe";
  if (p.toolChangeZMm > p.envZMm) return "over-travel";
  return null;
}
