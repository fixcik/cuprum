/** Z-headroom guard for the drill run: verify the bound work-zero leaves the run's
 *  Z moves inside the machine envelope, so neither the plunge nor a safe-Z / tool-change
 *  rapid trips a GRBL soft limit (ALARM:2) mid-run. Pure — unit-tested.
 *
 *  Geometry (GRBL): with homing + soft limits ($20=1) the work envelope is the
 *  negative half, `Z ∈ [−$132, 0]`, so the travel floor is `−maxTravelZMm` and the
 *  ceiling is `0`. The machine Z of the work-zero is the work-coordinate offset
 *  `WCO_z = mposZ − wposZ` (constant regardless of the current position — after a probe
 *  + retract it still resolves to the bound point).
 *
 *  Two bounds, symmetric around the bound zero:
 *  - FLOOR (zero too low): the deepest plunge in work coords is `−plungeDepth`, machine
 *    Z `WCO_z − plungeDepth`; safe while `WCO_z − plungeDepth ≥ −maxTravelZMm + margin`.
 *  - CEILING (zero too high): the run rapids UP to safe-Z and tool-change-Z; the highest
 *    is `max(safeZ, toolChangeZ)`, machine Z `WCO_z + max(safeZ, toolChangeZ)`. Safe while
 *    that stays `≤ 0 − margin`. If the operator zeroes near the top of travel, these rapids
 *    punch through the ceiling → ALARM:2 on the first lift / tool change.
 *
 *  We can only trust this when the envelope is computable — the frame is homed and soft
 *  limits are on and `$132` is known. Otherwise the check is SKIPPED (treated as ok):
 *  the bounds are unknown, so we don't block on a guess (the homing-gate task #532 and
 *  the reactive ALARM message #534 cover that case). */
export interface ZHeadroomArgs {
  /** Live machine Z (mm) — `status.mpos[2]`. */
  mposZ: number;
  /** Live work Z (mm) — `status.wpos[2]`. */
  wposZ: number;
  /** Frame referenced (homed). The envelope is only meaningful once homed. */
  homed: boolean;
  /** GRBL soft-limits ($20). null = unknown. The bounds only bite when soft limits
   *  are on; with them off there is no ALARM:2 to prevent. */
  softLimitsEnabled: boolean | null;
  /** GRBL Z max travel ($132) in mm. null/≤0 = unknown → skip. */
  maxTravelZMm: number | null;
  /** Deepest plunge depth (mm, positive) = substrate thickness + breakthrough. */
  plungeDepthMm: number;
  /** Work-frame safe-Z (mm) the run rapids to between holes. */
  safeZMm: number;
  /** Work-frame tool-change-Z (mm) the run rapids to on a tool change. */
  toolChangeZMm: number;
  /** Safety margin (mm) kept inside each bound. Defaults to 0.5. */
  marginMm?: number;
}

export interface ZHeadroomResult {
  /** Safe to drill — either inside both bounds, or the check was skipped. */
  ok: boolean;
  /** The check could not be evaluated (not homed / soft limits off / $132 unknown). */
  skipped: boolean;
  /** Which bound is violated when !ok: "below" = work-zero too low (no room for the
   *  plunge), "above" = work-zero too high (safe/tool-change rapid punches the ceiling).
   *  null when ok or skipped. Floor takes precedence if (rarely) both fail. */
  block: "below" | "above" | null;
  /** Downward travel needed below the work-zero: `plungeDepthMm + margin`. */
  neededMm: number;
  /** Downward travel actually available below the work-zero: `WCO_z + maxTravelZMm`.
   *  0 when skipped (unknown). */
  availableMm: number;
  /** How far the highest rapid (max of safe/tool-change Z) overshoots the ceiling,
   *  margin included: `WCO_z + max(safeZ, toolChangeZ) + margin`. >0 ⇒ "above" block;
   *  ≤0 when the rapid fits (==0 exactly at the margin boundary). Also 0 when skipped —
   *  gate on `skipped` first to tell the two apart. */
  ceilingOverMm: number;
}

export const DEFAULT_Z_HEADROOM_MARGIN_MM = 0.5;

export function checkZHeadroom(args: ZHeadroomArgs): ZHeadroomResult {
  const {
    mposZ,
    wposZ,
    homed,
    softLimitsEnabled,
    maxTravelZMm,
    plungeDepthMm,
    safeZMm,
    toolChangeZMm,
    marginMm = DEFAULT_Z_HEADROOM_MARGIN_MM,
  } = args;

  const neededMm = plungeDepthMm + marginMm;

  // Envelope is only computable on a referenced frame with soft limits and a known $132.
  if (!homed || softLimitsEnabled !== true || maxTravelZMm == null || maxTravelZMm <= 0) {
    return { ok: true, skipped: true, block: null, neededMm, availableMm: 0, ceilingOverMm: 0 };
  }

  // Machine Z of the work-zero, then room from there to each bound.
  const wcoZ = mposZ - wposZ;
  const availableMm = wcoZ + maxTravelZMm; // down to the floor (−$132)
  // Highest work-frame rapid; how far its machine Z punches past the ceiling (0).
  const maxUpMm = Math.max(safeZMm, toolChangeZMm);
  const ceilingOverMm = wcoZ + maxUpMm + marginMm;

  const floorOk = availableMm >= neededMm;
  const ceilingOk = ceilingOverMm <= 0;
  const block = !floorOk ? "below" : !ceilingOk ? "above" : null;

  return { ok: floorOk && ceilingOk, skipped: false, block, neededMm, availableMm, ceilingOverMm };
}
