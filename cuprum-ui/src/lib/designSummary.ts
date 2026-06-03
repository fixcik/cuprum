import type { Verdict } from "@/lib/feasibility";

export interface VerdictRollup {
  ok: number;
  warn: number;
  block: number;
}

/** Tally designs by overall DFM verdict for the gallery header summary.
 *  Designs whose verdict has not settled yet (null/undefined) are skipped. */
export function rollupVerdicts(verdicts: ReadonlyArray<Verdict | null | undefined>): VerdictRollup {
  const r: VerdictRollup = { ok: 0, warn: 0, block: 0 };
  for (const v of verdicts) {
    if (v === "ok") r.ok++;
    else if (v === "warn") r.warn++;
    else if (v === "block") r.block++;
  }
  return r;
}
