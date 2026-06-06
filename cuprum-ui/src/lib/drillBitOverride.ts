import type { Tool } from "@/lib/toolLibrary";

/** Closest drill-kind tool to diameterMm (no tolerance filter), or null.
 *  When two tools are equidistant the one earlier in the array wins. */
export function nearestBit(diameterMm: number, tools: Tool[]): Tool | null {
  let best: Tool | null = null;
  let bestErr = Infinity;
  for (const t of tools) {
    if (t.kind !== "drill") continue;
    const err = Math.abs(t.diameterMm - diameterMm);
    if (err < bestErr) {
      best = t;
      bestErr = err;
    }
  }
  return best;
}
