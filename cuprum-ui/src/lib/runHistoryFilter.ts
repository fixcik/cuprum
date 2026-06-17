import type { OperationRun } from "@/lib/api";
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

/** Labels resolved by the caller (which owns the i18n namespace). Keeping i18n
 *  out of this module lets the static i18n checker scope keys correctly. */
export interface RunLabels {
  /** Resolved meta prefix, e.g. t("runHistory.holesLabel"). */
  holes: string;
  /** Resolved meta prefix, e.g. t("runHistory.toolsLabel"). */
  tools: string;
  /** Resolved op-type display name by opType, e.g. (op) => t(operationKind(op).titleKey). */
  typeLabel: (opType: string) => string;
}

/** Short meta line under the op name in a history row; also the search haystack.
 *  Built from cheap run fields (progress + drill tool count). */
export function runMetaLine(run: OperationRun, L: Pick<RunLabels, "holes" | "tools">): string {
  const parts: string[] = [];
  if (run.progressTotal != null) parts.push(`${L.holes} ${run.progressTotal}`);
  try {
    const p = JSON.parse(run.paramsJson) as { toolCount?: number };
    if (p.toolCount != null) parts.push(`${L.tools} ${p.toolCount}`);
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
  labels: RunLabels;
}

/** base (selStep) → status → query (case-insensitive substring over type label + meta). */
export function filterRuns({ runs, selStep, status, query, labels }: FilterInput): OperationRun[] {
  let out = selStep ? runs.filter((r) => r.opType === selStep) : runs;
  if (status !== "all") out = out.filter((r) => statusKey(r.outcome) === status);
  const q = query.trim().toLowerCase();
  if (q) {
    out = out.filter((r) =>
      `${labels.typeLabel(r.opType)} ${runMetaLine(r, labels)}`.toLowerCase().includes(q),
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
