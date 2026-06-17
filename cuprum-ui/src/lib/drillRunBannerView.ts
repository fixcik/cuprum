const ACTIVE_PHASES = new Set([
  "running",
  "pausing",
  "paused",
  "stopping",
  "awaitingToolChange",
]);

/** Banner shows only for a live run in an active phase. */
export function isBannerVisible(active: boolean, phase: string): boolean {
  return active && ACTIVE_PHASES.has(phase);
}

/** Phase → i18n label key (under `project`) + whether the status dot pulses. */
export function phaseLabel(phase: string): { key: string; pulsing: boolean } {
  switch (phase) {
    case "paused":
    case "pausing":
      return { key: "operations.banner.paused", pulsing: false };
    case "awaitingToolChange":
      return { key: "operations.banner.toolChange", pulsing: false };
    case "stopping":
      return { key: "operations.banner.stopping", pulsing: false };
    case "running":
    default:
      return { key: "operations.banner.running", pulsing: true };
  }
}

/** Completion percent (0–100); 0 when total is unknown. */
export function percent(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}
