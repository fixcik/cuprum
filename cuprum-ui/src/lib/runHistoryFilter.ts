import type { OperationRun } from "@/lib/api";
import { operationKind } from "@/lib/operationKind";
import { dayBucket } from "@/lib/runHistoryFormat";

/** Status filter values (chip ids). `interrupted` folds in `error`. */
export type StatusFilter = "all" | "completed" | "stopped" | "interrupted";
/** Per-run status bucket (also drives the badge). */
export type RunStatus = "completed" | "stopped" | "interrupted" | "running";

/** Collapse the DB `outcome` into a display/filter bucket. */
export function statusKey(outcome: string | null): RunStatus {
  if (outcome === "completed") return "completed";
  if (outcome === "stopped") return "stopped";
  if (outcome === "error" || outcome === "interrupted") return "interrupted";
  return "running";
}

/** Human-facing label for an op type, via the i18n resolver. */
function typeLabel(opType: string, t: (k: string) => string): string {
  return t(operationKind(opType).titleKey);
}

/** Short meta line shown under the op name in a history row; also the search
 *  haystack. Built from cheap run fields (progress + drill tool count). */
export function runMetaLine(run: OperationRun, t: (k: string) => string): string {
  const parts: string[] = [];
  if (run.progressTotal != null) parts.push(`${t("runHistory.holesLabel")} ${run.progressTotal}`);
  try {
    const p = JSON.parse(run.paramsJson) as { toolCount?: number };
    if (p.toolCount != null) parts.push(`${t("runHistory.toolsLabel")} ${p.toolCount}`);
  } catch {
    /* ignore malformed params */
  }
  return parts.join(" · ");
}

export interface FilterInput {
  runs: OperationRun[];
  selStep: string | null;
  status: StatusFilter;
  query: string;
  t: (k: string) => string;
}

/** base (selStep) → status → query (case-insensitive substring over type label + meta). */
export function filterRuns({ runs, selStep, status, query, t }: FilterInput): OperationRun[] {
  let out = selStep ? runs.filter((r) => r.opType === selStep) : runs;
  if (status !== "all") out = out.filter((r) => statusKey(r.outcome) === status);
  const q = query.trim().toLowerCase();
  if (q) {
    out = out.filter((r) =>
      `${typeLabel(r.opType, t)} ${runMetaLine(r, t)}`.toLowerCase().includes(q),
    );
  }
  return out;
}

/** Counts per chip over a base set (already scoped to selStep). `running` excluded
 *  from named counts but still in `all`. */
export function statusCounts(base: OperationRun[]): Record<StatusFilter, number> {
  const c: Record<StatusFilter, number> = { all: base.length, completed: 0, stopped: 0, interrupted: 0 };
  for (const r of base) {
    const k = statusKey(r.outcome);
    if (k !== "running") c[k] += 1;
  }
  return c;
}

export interface DayGroup {
  days: number;
  runs: OperationRun[];
}

/** Group an already-ordered (newest-first) run list into consecutive day buckets. */
export function groupByDay(runs: OperationRun[], nowSec = Date.now() / 1000): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const r of runs) {
    const { days } = dayBucket(r.startedAt, nowSec);
    const last = groups[groups.length - 1];
    if (last && last.days === days) last.runs.push(r);
    else groups.push({ days, runs: [r] });
  }
  return groups;
}
