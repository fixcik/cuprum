/** Z feasibility for a drill run, independent of where the per-tool Z zero lands.
 *  Z zero is set per tool by probing DURING the run, so it isn't known at preflight;
 *  we gate on the travel size instead. All inputs are positive magnitudes in mm. */
export type ZGateReason = "depth" | "toolchange" | "span";

export type ZGateResult = { valid: true } | { valid: false; reasons: ZGateReason[] };

const EPS_MM = 1e-3;

export function checkZGate(p: {
  safeZMm: number;
  toolChangeZMm: number;
  depthMm: number;
  envZMm: number;
}): ZGateResult {
  const depthFails = p.depthMm > p.envZMm + EPS_MM;
  const toolChangeFails = p.toolChangeZMm > p.envZMm + EPS_MM;
  const reasons: ZGateReason[] = [];
  if (depthFails) reasons.push("depth");
  if (toolChangeFails) reasons.push("toolchange");
  // The deepest cut (-depth) and the highest park (+toolChangeZ) must both fit the
  // travel no matter where the surface sits within it → their sum must fit. Only
  // surface this when neither individual limit already failed (else it's redundant).
  if (!depthFails && !toolChangeFails && p.depthMm + p.toolChangeZMm > p.envZMm + EPS_MM)
    reasons.push("span");
  return reasons.length ? { valid: false, reasons } : { valid: true };
}

/** Localised reason list for the start hint, e.g. "глубина, размах". */
export function formatZReasons(reasons: ZGateReason[], label: (r: ZGateReason) => string): string {
  return reasons.map(label).join(", ");
}
