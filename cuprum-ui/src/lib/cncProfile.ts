/** CNC machine profile — the second fixed slot beside the UV `profile`. Connection
 *  + jog fields (Phase 1) plus the machine limits/params the drilling G-code emitter
 *  (Phase 4) and DFM will consume. Persisted in settingsStore. A full machine
 *  registry (multiple machines, probe/homing/collet) is a later workstream. */
export interface CncProfile {
  name: string;
  // --- connection (Phase 1) ---
  /** Last-used serial port; null until first connect. */
  port: string | null;
  baud: number;
  // --- jog (Phase 1) ---
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
  // --- emission (consumed by the Phase 4 G-code emitter) ---
  gcodeDialect: "grbl_1_1";
  /** Work-coordinate safe-Z (mm), used by the drilling G-code emitter for retracts. */
  safeZMm: number;
  /** Machine-coordinate (G53) safe retract height (mm), ≤ 0. Used for safe
   *  traverses during manual control. */
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

export const DEFAULT_CNC_PROFILE: CncProfile = {
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
