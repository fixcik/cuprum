/** Work zero in machine coords from a status sample: machine pos of work origin
 *  = MPos − WPos. XY only. */
export function workZeroFromStatus(
  mpos: readonly number[],
  wpos: readonly number[],
): { x: number; y: number } {
  return { x: mpos[0] - wpos[0], y: mpos[1] - wpos[1] };
}

/** Parse a GRBL `$$` settings line for the homing-enable flag ($22).
 *  Returns true/false if the line is `$22=<n>`, else null (not that line). */
export function parseHomingEnabled(line: string): boolean | null {
  const m = line.trim().match(/^\$22=(\d+)/);
  return m ? m[1] !== "0" : null;
}

/** Parse a GRBL `$$` settings line for the soft-limits-enable flag ($20).
 *  Returns true/false if the line is `$20=<n>`, else null (not that line). */
export function parseSoftLimitsEnabled(line: string): boolean | null {
  const m = line.trim().match(/^\$20=(\d+)/);
  return m ? m[1] !== "0" : null;
}

/** Parse a GRBL `$$` line for max spindle speed ($30, RPM). This is the firmware
 *  ceiling the S word is clamped to and mapped to 100 % PWM, so it's the real
 *  scale for the spindle gauge. Returns the value if the line is `$30=<n>`, else
 *  null (not that line). */
export function parseMaxSpindle(line: string): number | null {
  const m = line.trim().match(/^\$30=([\d.]+)/);
  return m ? Number(m[1]) : null;
}

/** Parse a GRBL `$$` max-travel line ($130/$131/$132 → X/Y/Z) into the axis
 *  index (0=X, 1=Y, 2=Z) and its value in mm. Returns null for any other line. */
export function parseMaxTravel(line: string): { axis: 0 | 1 | 2; value: number } | null {
  const m = line.trim().match(/^\$(130|131|132)=([\d.]+)/);
  if (!m) return null;
  const axis = (Number(m[1]) - 130) as 0 | 1 | 2;
  return { axis, value: Number(m[2]) };
}

/** G-code to set the G54 work offset so work XY-zero = the saved machine point. */
export function restoreZeroGcode(z: { x: number; y: number }): string {
  return `G10 L2 P1 X${z.x.toFixed(3)} Y${z.y.toFixed(3)}`;
}
