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
  // --- emission (consumed by the Phase 4 G-code emitter) ---
  gcodeDialect: "grbl_1_1";
  safeZMm: number;
  // --- mechanics (DFM / future compensation) ---
  runoutMm: number;
  backlashMm: { x: number; y: number; z: number };
  // --- free-form G-code wrappers ---
  prependGcode: string;
  appendGcode: string;
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
  gcodeDialect: "grbl_1_1",
  safeZMm: 5,
  runoutMm: 0.15,
  backlashMm: { x: 0.05, y: 0.1, z: 0.05 },
  prependGcode: "",
  appendGcode: "",
};
