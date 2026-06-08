/** Spindle scale conversions.
 *
 *  Two different scales must NOT be conflated:
 *   - The GRBL **S word** runs over [0, $30] and maps to 0–100 % PWM. `$30`
 *     (`sMax`) is a firmware ceiling/index, not a shaft speed — commanding S
 *     above it is clamped.
 *   - The **physical spindle** reaches `physMax` real RPM at 100 % PWM (the
 *     profile's spindleMaxRpm).
 *
 *  So the UI shows/edits real RPM but commands the S word, scaling between the
 *  two by the ratio sMax/physMax. With `sMax === physMax` every conversion is
 *  identity (firmware already speaks real RPM, or $30 not yet known). */

/** Fraction of full power (0..1) from the reported S word and the GRBL ceiling. */
export function spindleFraction(reportedS: number, sMax: number): number {
  if (sMax <= 0) return 0;
  return Math.min(1, Math.max(0, reportedS / sMax));
}

/** Real shaft RPM for a power fraction, given the physical max. */
export function fractionToRpm(fraction: number, physMax: number): number {
  return Math.round(fraction * physMax);
}

/** Convert a real-RPM target to the GRBL S word to command (`M3 S<n>`), scaling
 *  by the firmware ceiling. Clamps the input to physMax first. */
export function rpmToSWord(rpm: number, physMax: number, sMax: number): number {
  if (physMax <= 0) return 0;
  const clamped = Math.min(Math.max(rpm, 0), physMax);
  return Math.round((clamped / physMax) * sMax);
}

/** Convert a GRBL S word (e.g. the $31 min-speed setting) to real shaft RPM,
 *  scaling by the firmware ceiling. Inverse of {@link rpmToSWord}. Clamps the input
 *  to [0, sMax] first. Returns 0 when sMax is unknown/non-positive. */
export function sWordToRpm(s: number, physMax: number, sMax: number): number {
  if (sMax <= 0) return 0;
  const clamped = Math.min(Math.max(s, 0), sMax);
  return Math.round((clamped / sMax) * physMax);
}
