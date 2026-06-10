import type { ExposeSnapshot, Manifest } from "@/lib/api";

/** Default exposure time (seconds) used when no persisted setting is available. */
export const DEFAULT_EXPOSURE_S = 60;
/** Default UV backlight PWM (0–255). */
export const DEFAULT_PWM = 255;

/** Build an ExposeSnapshot from the main-window store values.
 *  Pure function — no IPC, testable in isolation. */
export function buildExposeSnapshot(args: {
  workingDir: string | null;
  currentPath: string | null;
  manifest: Manifest | null;
  side?: "top" | "bottom";
  mirror?: boolean;
  invert?: boolean;
  exposureS?: number;
  pwm?: number;
}): ExposeSnapshot {
  return {
    workingDir: args.workingDir,
    currentPath: args.currentPath,
    manifest: args.manifest,
    side: args.side ?? "top",
    mirror: args.mirror ?? false,
    invert: args.invert ?? false,
    exposureS: args.exposureS ?? DEFAULT_EXPOSURE_S,
    pwm: args.pwm ?? DEFAULT_PWM,
  };
}
