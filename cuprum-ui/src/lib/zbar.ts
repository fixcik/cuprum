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
