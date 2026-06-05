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
  // --- emission (consumed by G-code emitter) ---
  gcodeDialect: "grbl_1_1";
  safeZMm: number;
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
  gcodeDialect: "grbl_1_1",
  safeZMm: 5,
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
