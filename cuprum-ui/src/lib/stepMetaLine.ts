import type { OperationRun } from "@/lib/api";
import { formatDuration, type DurationLabels } from "@/lib/runHistoryFormat";

/** Labels resolved by the caller (component owns the i18n namespace; keeping i18n
 *  out of this module lets the static i18n checker scope keys correctly). */
export interface StepMetaLabels {
  /** "отв." */
  holes: string;
  /** Pluralized tool count, e.g. (2) => "2 сверла". */
  tools: (n: number) => string;
  /** {h,m,s} short unit labels for the estimate. */
  dur: DurationLabels;
  /** "с" (seconds suffix for exposure time). */
  sec: string;
  /** Copper side label, e.g. ("top") => "Верх". */
  side: (s: string) => string;
}

/** Cheap per-step parameter line from the LAST run (no fresh planner). Returns null
 *  when there's no run or nothing extractable. drill → holes · tools · ≈estimate;
 *  expose → side · exposure; mill (not journalled) and everything else → null. */
export function stepMetaLine(run: OperationRun | null, L: StepMetaLabels): string | null {
  if (!run) return null;
  const parts: string[] = [];

  if (run.opType === "drill") {
    if (run.progressTotal != null) parts.push(`${run.progressTotal} ${L.holes}`);
    try {
      const p = JSON.parse(run.paramsJson) as { toolCount?: number; estimateSec?: number };
      if (p.toolCount != null && p.toolCount > 0) parts.push(L.tools(p.toolCount));
      if (p.estimateSec != null && p.estimateSec > 0) {
        parts.push(`≈ ${formatDuration(p.estimateSec, L.dur)}`);
      }
    } catch {
      /* ignore malformed params */
    }
  } else if (run.opType === "expose") {
    try {
      const p = JSON.parse(run.paramsJson) as { side?: string; exposureS?: number };
      if (p.side) parts.push(L.side(p.side));
      if (p.exposureS != null && p.exposureS > 0) parts.push(`${p.exposureS} ${L.sec}`);
    } catch {
      /* ignore malformed params */
    }
  }

  return parts.length ? parts.join(" · ") : null;
}
