/** Map a vertical fraction of the Z bar (0 = bottom, 1 = top) to a machine Z
 *  within the envelope [-envZ, 0]. The fraction is clamped to [0, 1] so a click
 *  slightly past either end still resolves to a valid in-envelope target. */
export function machineZFromFraction(fracFromBottom: number, envZ: number): number {
  const f = Math.min(1, Math.max(0, fracFromBottom));
  const zMin = -Math.abs(envZ);
  return zMin + f * Math.abs(envZ);
}

/** Parse a typed machine-Z target (the inline-editable readout) against the bar's
 *  travel `[−|envZ|, 0]`. Accepts a decimal comma as well as a dot. Returns the value
 *  when it is a finite number inside the envelope, else null — the caller treats null
 *  as invalid (no jog, revert). Out-of-range is rejected rather than clamped: the user
 *  asked for an exact height, so silently retargeting elsewhere would be surprising. */
export function parseZTarget(text: string, envZ: number): number | null {
  const s = text.trim();
  if (s === "") return null; // Number("") is 0 — guard the empty/whitespace input
  const v = Number(s.replace(",", "."));
  if (!Number.isFinite(v)) return null;
  const lo = -Math.abs(envZ);
  if (v < lo || v > 0) return null;
  return v;
}

/** Safe-descent predicate for the fiducial capture Z bar.
 *
 *  In safe-descent mode only upward track clicks are allowed: the operator may
 *  raise Z freely but must use the Z− button for controlled descent (slow feed).
 *  A track click is "safe" when the target is AT or ABOVE the current position.
 *
 *  Both arguments are work-frame Z (mm, negative = below surface). The caller
 *  passes the clicked target and the live wpos[2]. An upward click (target ≥ current)
 *  returns true; a downward click (target < current) returns false and must be
 *  ignored/clamped by the caller.
 *
 *  A tiny epsilon (0.1 mm) guards against floating-point jitter from track clicks
 *  that land exactly at the live position — they are treated as upward. */
export function isSafeDescentTarget(currentWorkZ: number, targetWorkZ: number): boolean {
  return targetWorkZ >= currentWorkZ - 0.1;
}
