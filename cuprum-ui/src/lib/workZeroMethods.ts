/**
 * Pure logic for the work-zero registration methods UI:
 *  - which of the three methods are available (and why not);
 *  - the state of the "Work zero" status card on the drill plan screen.
 *
 * Method 1 — corner datum (jog to the board corner, zero there). Offset only.
 * Method 2 — manual capture of 2+ panel alignment points. Offset + rotation.
 * Method 3 — 3D touch probe over 2+ probeable holes. Offset + rotation.
 */

import { classifyRms, type RmsSeverity } from "@/lib/fiducialRegistration";

/** Registration method id. */
export type WorkZeroMethod = 1 | 2 | 3;

/** The session-scoped result of a successful registration. */
export interface WorkZeroBinding {
  method: WorkZeroMethod;
  /** RMS residual (mm) of the fit; null for method 1 (no redundancy → no estimate). */
  rmsMm: number | null;
  /** Detected board rotation (deg); null for method 1 (rotation not measured). */
  angleDeg: number | null;
}

/** Why a method card is unavailable. */
export type MethodUnavailableReason =
  | "disconnected"
  | "wizardPending"
  | "probeNotConfigured"
  | "noProbeableHoles";

export interface MethodAvailability {
  available: boolean;
  reason: MethodUnavailableReason | null;
}

export interface MethodAvailabilityArgs {
  /** Machine connection — offline blocks all three methods. */
  connected: boolean;
  /** Whether a 3D touch probe is configured in equipment (method 3). */
  probeReady: boolean;
  /** Number of probeable points/holes (Ø ≥ threshold) on the panel (method 3). */
  probeableCount: number;
  /** Whether the method 3 probe wizard is implemented. False until that phase
   *  ships — a probe-ready panel then shows a "coming soon" notice. The manual
   *  points wizard (method 2) has shipped and needs no gate. */
  probeWizardReady?: boolean;
}

/** Availability (+ blocking reason) for each of the three method cards. */
export function methodAvailability(
  args: MethodAvailabilityArgs,
): Record<WorkZeroMethod, MethodAvailability> {
  const { connected, probeReady, probeableCount, probeWizardReady = false } = args;
  const blocked = (reason: MethodUnavailableReason): MethodAvailability => ({
    available: false,
    reason,
  });
  const ok: MethodAvailability = { available: true, reason: null };
  if (!connected) {
    return { 1: blocked("disconnected"), 2: blocked("disconnected"), 3: blocked("disconnected") };
  }
  // Method 2 always has candidates: the wizard offers the four panel corners
  // alongside the panel's alignment points, so no preparation is required.
  const m2 = ok;
  const m3 = !probeReady
    ? blocked("probeNotConfigured")
    : probeableCount < 2
      ? blocked("noProbeableHoles")
      : probeWizardReady
        ? ok
        : blocked("wizardPending");
  return { 1: ok, 2: m2, 3: m3 };
}

/** Quality shown on the card chip: RMS severity, or "none" = "no estimate"
 *  (method 1 — a single-point bind has no residual to judge). */
export type CardQuality = RmsSeverity | "none";

/** Resolved presentation state of the work-zero status card. */
export interface WorkZeroCardState {
  kind: "disconnected" | "unset" | "set";
  /** Bound method (only when kind = "set"). Falls back to 1 when the zero is
   *  bound but no method metadata is present (e.g. legacy bind path). */
  method: WorkZeroMethod | null;
  quality: CardQuality;
  rmsMm: number | null;
  angleDeg: number | null;
  /** The bound zero puts holes outside the machine travel (XY gate). */
  overrun: boolean;
}

export interface CardStateArgs {
  connected: boolean;
  /** Whether the XY work zero is currently bound (machine session state). */
  workZeroSet: boolean;
  /** Method metadata of the bind, if known. */
  binding: WorkZeroBinding | null;
  /** XY gate overrun at the bound zero. */
  xyOverrun: boolean;
}

/** Compute the card state from machine + binding facts. */
export function cardState(args: CardStateArgs): WorkZeroCardState {
  const { connected, workZeroSet, binding, xyOverrun } = args;
  if (!connected) {
    return { kind: "disconnected", method: null, quality: "none", rmsMm: null, angleDeg: null, overrun: false };
  }
  if (!workZeroSet) {
    return { kind: "unset", method: null, quality: "none", rmsMm: null, angleDeg: null, overrun: false };
  }
  const method = binding?.method ?? 1;
  const rmsMm = binding?.rmsMm ?? null;
  const quality: CardQuality = method !== 1 && rmsMm != null ? classifyRms(rmsMm) : "none";
  return {
    kind: "set",
    method,
    quality,
    rmsMm,
    angleDeg: binding?.angleDeg ?? null,
    overrun: xyOverrun,
  };
}
