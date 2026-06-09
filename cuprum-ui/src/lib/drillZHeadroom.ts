/** Z-headroom guard for the drill run: verify the bound work-zero leaves enough
 *  downward travel for the plunge, so the cut never trips a GRBL soft limit
 *  (ALARM:2) mid-run. Pure — unit-tested.
 *
 *  Geometry (GRBL): with homing + soft limits ($20=1) the work envelope is the
 *  negative half, `Z ∈ [−$132, 0]`, so the travel floor is `−maxTravelZMm`. The
 *  machine Z of the work-zero is the work-coordinate offset `WCO_z = mposZ − wposZ`
 *  (constant regardless of the current position — after a probe + retract it still
 *  resolves to the bound point). The deepest plunge in work coords is `−plungeDepth`,
 *  i.e. machine Z `WCO_z − plungeDepth`. The cut is safe while that stays at or above
 *  the floor: `WCO_z − plungeDepth ≥ −maxTravelZMm + margin`.
 *
 *  We can only trust this when the floor is computable — the frame is homed and soft
 *  limits are on and `$132` is known. Otherwise the check is SKIPPED (treated as ok):
 *  the floor is unknown, so we don't block on a guess (the homing-gate task #532 and
 *  the reactive ALARM message #534 cover that case). */
export interface ZHeadroomArgs {
  /** Live machine Z (mm) — `status.mpos[2]`. */
  mposZ: number;
  /** Live work Z (mm) — `status.wpos[2]`. */
  wposZ: number;
  /** Frame referenced (homed). The floor is only meaningful once homed. */
  homed: boolean;
  /** GRBL soft-limits ($20). null = unknown. The floor only bites when soft limits
   *  are on; with them off there is no ALARM:2 to prevent. */
  softLimitsEnabled: boolean | null;
  /** GRBL Z max travel ($132) in mm. null/≤0 = unknown → skip. */
  maxTravelZMm: number | null;
  /** Deepest plunge depth (mm, positive) = substrate thickness + breakthrough. */
  plungeDepthMm: number;
  /** Safety margin (mm) kept above the floor. Defaults to 0.5. */
  marginMm?: number;
}

export interface ZHeadroomResult {
  /** Safe to drill — either enough room, or the check was skipped (unknown floor). */
  ok: boolean;
  /** The check could not be evaluated (not homed / soft limits off / $132 unknown). */
  skipped: boolean;
  /** Downward travel needed below the work-zero: `plungeDepthMm + margin`. */
  neededMm: number;
  /** Downward travel actually available below the work-zero: `WCO_z + maxTravelZMm`.
   *  0 when skipped (unknown). */
  availableMm: number;
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
    marginMm = DEFAULT_Z_HEADROOM_MARGIN_MM,
  } = args;

  const neededMm = plungeDepthMm + marginMm;

  // Floor is only computable on a referenced frame with soft limits and a known $132.
  if (!homed || softLimitsEnabled !== true || maxTravelZMm == null || maxTravelZMm <= 0) {
    return { ok: true, skipped: true, neededMm, availableMm: 0 };
  }

  // Machine Z of the work-zero, then room from there down to the floor (−$132).
  const wcoZ = mposZ - wposZ;
  const availableMm = wcoZ + maxTravelZMm;
  return { ok: availableMm >= neededMm, skipped: false, neededMm, availableMm };
}
