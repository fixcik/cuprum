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

/** G-code to set the G54 work offset so work XY-zero = the saved machine point. */
export function restoreZeroGcode(z: { x: number; y: number }): string {
  return `G10 L2 P1 X${z.x.toFixed(3)} Y${z.y.toFixed(3)}`;
}
