import type {
  ExposeSnapshot,
  ExposeRunRequest,
  MirrorAxis,
  Manifest,
} from "@/lib/api";

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
  placedSizes?: Record<string, { w: number; h: number }>;
  side?: "top" | "bottom";
  mirrorAxis?: MirrorAxis;
  invert?: boolean;
  exposureS?: number;
  pwm?: number;
}): ExposeSnapshot {
  return {
    workingDir: args.workingDir,
    currentPath: args.currentPath,
    manifest: args.manifest,
    placedSizes: args.placedSizes ?? {},
    side: args.side ?? "top",
    mirrorAxis: args.mirrorAxis ?? "none",
    invert: args.invert ?? false,
    exposureS: args.exposureS ?? DEFAULT_EXPOSURE_S,
    pwm: args.pwm ?? DEFAULT_PWM,
  };
}

/** Build an `ExposeRunRequest` from a snapshot and params override.
 *  Pure function — no IPC, unit-testable.
 *
 *  Only the designs referenced by placed panel instances are included.
 *  The caller must pass a freshly-generated `runUid`. */
export function buildExposeRequest(
  snap: ExposeSnapshot,
  params: {
    side: "top" | "bottom";
    mirrorAxis: MirrorAxis;
    invert: boolean;
    exposureS: number;
    pwm: number;
    runUid: string;
  },
): ExposeRunRequest | null {
  const manifest = snap.manifest;
  const workingDir = snap.workingDir;

  if (!manifest || !workingDir) return null;

  const panel = manifest.panel;
  if (!panel) return null;

  // Collect the design IDs that are actually placed on the panel.
  const placedDesignIds = new Set(panel.instances.map((inst) => inst.design_id));

  // Only include designs that have at least one placed instance.
  const designs = manifest.designs
    .filter((d) => placedDesignIds.has(d.id))
    .map((d) => ({
      id: d.id,
      gerbers: d.gerbers.map((g) => ({
        path: g.path,
        layerType: g.layer_type,
      })),
    }));

  if (designs.length === 0) return null;

  return {
    workingDir,
    panel: {
      widthMm: panel.width_mm,
      heightMm: panel.height_mm,
      instances: panel.instances.map((inst) => ({
        designId: inst.design_id,
        xMm: inst.x_mm,
        yMm: inst.y_mm,
        rotationDeg: inst.rotation_deg,
      })),
    },
    designs,
    side: params.side,
    mirrorAxis: params.mirrorAxis,
    invert: params.invert,
    exposureS: params.exposureS,
    pwm: params.pwm,
    runUid: params.runUid,
  };
}
