/** Minimal CNC machine profile — the second fixed slot beside the UV `profile`.
 *  v1 only needs connection + jog/spindle defaults; a full MachineProfile lands
 *  in Phase 2 of the drilling workstream. Persisted in settingsStore. */
export interface CncProfile {
  name: string;
  /** Last-used serial port (remembered between sessions); null until first connect. */
  port: string | null;
  baud: number;
  spindleMaxRpm: number;
  jogFeedMmMin: number;
  /** Selectable jog step sizes (mm). */
  jogStepsMm: number[];
}

export const DEFAULT_CNC_PROFILE: CncProfile = {
  name: "CNC 3018",
  port: null,
  baud: 115200,
  spindleMaxRpm: 9000,
  jogFeedMmMin: 500,
  jogStepsMm: [0.1, 1, 10],
};
