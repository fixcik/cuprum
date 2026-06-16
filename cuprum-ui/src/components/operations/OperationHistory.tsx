import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  XCircle,
  CircleSlash,
  Loader2,
  History as HistoryIcon,
  RotateCcw,
  Search,
} from "lucide-react";
import { api, type OperationRun } from "@/lib/api";
import { useShell } from "@/shellStore";
import { useFlag } from "@/hooks/useFlag";
import { relativeTime } from "@/i18n/relativeTime";
import { operationKind } from "@/lib/operationKind";
import { formatDuration } from "@/lib/runHistoryFormat";
import {
  filterRuns,
  statusCounts,
  groupByDay,
  runMetaLine,
  statusKey,
  type StatusFilter,
  type RunLabels,
} from "@/lib/runHistoryFilter";

/** Runs fetched per page; "load more" appends the next page. */
const PAGE_SIZE = 20;

interface DrillParams {
  toolCount?: number;
  feedOverridePct?: number;
  estimateSec?: number;
  selectedHoleIds?: string[];
}

function parseDrillParams(paramsJson: string): DrillParams {
  try {
    return JSON.parse(paramsJson) as DrillParams;
  } catch {
    return {};
  }
}

/** Op types that have a window to (re)open from a history card. */
const OPENABLE = new Set(["drill", "expose"]);

/** Open the op's window and prefill it with this run's config ("repeat run"). An
 *  already-open window is listening, so prefill it now; a fresh one consumes the
 *  pending prefill on its ready handshake. */
async function repeatRun(run: OperationRun) {
  if (run.opType === "drill") {
    const wasOpen = await api.openDrillWindow();
    if (wasOpen) api.emitDrillPrefill(run.paramsJson);
    else useShell.getState().setPendingDrillPrefill(run.paramsJson);
    return;
  }
  if (run.opType === "expose") {
    const wasOpen = await api.openExposeWindow();
    if (wasOpen) api.emitExposePrefill(run.paramsJson);
    else useShell.getState().setPendingExposePrefill(run.paramsJson);
    return;
  }
}

const CHIPS: StatusFilter[] = ["all", "completed", "stopped", "interrupted"];

/** Operation history as a grouped, searchable, status-filterable run log. Lives in
 *  the Operations view beside the production steps; selecting a step filters this
 *  list to that op type. Rows expand to read-only detail with a "repeat" action. */
export function OperationHistory({
  selStep,
  onClearStep,
}: {
  selStep: string | null;
  onClearStep: () => void;
}) {
  const { t } = useTranslation("project");
  const currentPath = useShell((s) => s.currentPath);
  // Gate the "repeat" action for expose runs the same way the operation card is
  // gated, so a past run can't reopen the expose window when the flag is off.
  const showExpose = useFlag("uvExposure");
  const [runs, setRuns] = useState<OperationRun[] | null>(null);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // First page on project change (resets filter/search/expansion so stale state
  // can't hide the new project's runs).
  useEffect(() => {
    setStatus("all");
    setQuery("");
    setExpanded(null);
    setHasMore(false);
    if (!currentPath) {
      setRuns([]);
      return;
    }
    setRuns(null);
    let active = true;
    void api.operationLog
      .list(currentPath, PAGE_SIZE, 0)
      .then((rows) => {
        if (!active) return;
        setRuns(rows);
        setHasMore(rows.length === PAGE_SIZE);
      })
      .catch(() => {
        if (active) setRuns([]);
      });
    return () => {
      active = false;
    };
  }, [currentPath]);

  // Track the loaded row count so the live-refresh listener can refetch exactly
  // the loaded window without re-subscribing on every `runs` change.
  const loadedCountRef = useRef(0);
  useEffect(() => {
    loadedCountRef.current = runs?.length ?? 0;
  }, [runs]);

  // Live refresh: a run launched/finished/reconciled in another window broadcasts
  // `operation-runs://changed`. Refetch the loaded window so a new run appears and
  // "Идёт" flips to its outcome. StrictMode-safe listener lifecycle.
  useEffect(() => {
    if (!currentPath) return;
    let active = true;
    let unlisten: (() => void) | null = null;
    let fetchGen = 0;
    void api.operationLog
      .onChanged(() => {
        if (!active) return;
        const gen = ++fetchGen;
        const count = Math.max(PAGE_SIZE, loadedCountRef.current);
        void api.operationLog
          .list(currentPath, count, 0)
          .then((rows) => {
            if (!active || gen !== fetchGen) return;
            setRuns(rows);
            setHasMore(rows.length === count);
          })
          .catch(() => {});
      })
      .then((un) => {
        if (active) unlisten = un;
        else un();
      });
    return () => {
      active = false;
      unlisten?.();
    };
  }, [currentPath]);

  const loadMore = () => {
    if (!currentPath || loadingMore) return;
    setLoadingMore(true);
    void api.operationLog
      .list(currentPath, PAGE_SIZE, runs?.length ?? 0)
      .then((rows) => {
        setRuns((prev) => [...(prev ?? []), ...rows]);
        setHasMore(rows.length === PAGE_SIZE);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
  };

  const labels: RunLabels = useMemo(
    () => ({
      holes: t("runHistory.holesLabel"),
      tools: t("runHistory.toolsLabel"),
      typeLabel: (op: string) => t(operationKind(op).titleKey),
    }),
    [t],
  );
  const durLabels = useMemo(
    () => ({
      h: t("runHistory.hourShort"),
      m: t("runHistory.minShort"),
      s: t("runHistory.secShort"),
    }),
    [t],
  );

  const base = useMemo(
    () => (selStep ? (runs ?? []).filter((r) => r.opType === selStep) : (runs ?? [])),
    [runs, selStep],
  );
  const counts = useMemo(() => statusCounts(base), [base]);
  const filtered = useMemo(
    () => filterRuns({ runs: runs ?? [], selStep, status, query, labels }),
    [runs, selStep, status, query, labels],
  );
  const groups = useMemo(() => groupByDay(filtered), [filtered]);

  const dayLabel = (days: number) =>
    days === 0 ? t("runHistory.day.today") : t("runHistory.day.daysAgo", { count: days });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 px-1 pb-3">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
          <HistoryIcon className="size-3.5" />
          {t("runHistory.title")}
        </div>
        {selStep && (
          <button
            type="button"
            onClick={onClearStep}
            className="inline-flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/15 px-2 py-0.5 text-[11px] text-primary"
          >
            {t(operationKind(selStep).titleKey)}
            <span aria-hidden>✕</span>
          </button>
        )}
        <span className="ml-auto text-[11.5px] text-muted-foreground tabular-nums">
          {t("runHistory.resultCount", { count: filtered.length })}
        </span>
      </div>

      {/* Toolbar */}
      <div className="mb-3 flex flex-wrap items-center gap-2.5 px-1">
        <div className="relative max-w-[280px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("runHistory.searchPlaceholder")}
            className="w-full rounded-lg border border-border bg-card/70 py-2 pl-8 pr-3 text-[12.5px] text-foreground placeholder:text-muted-foreground/70 focus:border-primary/50 focus:outline-none"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setStatus(c)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-semibold tabular-nums transition-colors ${
                status === c
                  ? "bg-primary text-primary-foreground"
                  : "border border-border bg-card/70 text-muted-foreground hover:text-foreground"
              }`}
            >
              {c === "all" ? t("runHistory.filterAll") : t(`runHistory.filter.${c}`)}
              <span className="opacity-60">{counts[c]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      {runs === null ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : !currentPath ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[12px] text-muted-foreground">
          {t("runHistory.noProject")}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-16 text-center">
          <Search className="size-8 text-muted-foreground/60" />
          <div className="text-[13px] text-muted-foreground">{t("runHistory.notFound.title")}</div>
          <div className="text-[11.5px] text-muted-foreground/70">{t("runHistory.notFound.hint")}</div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
          {groups.map((g) => (
            <div key={g.days} className="flex flex-col gap-1.5">
              <div className="sticky top-0 z-10 flex items-center gap-3 bg-background px-0.5 pb-2 pt-2.5">
                <span className="text-[11px] font-bold uppercase tracking-[0.08em] text-muted-foreground">
                  {dayLabel(g.days)}
                </span>
                <span className="h-px flex-1 bg-border/60" />
              </div>
              {g.runs.map((r) => (
                <RunRow
                  key={r.runUid}
                  run={r}
                  t={t}
                  labels={labels}
                  durLabels={durLabels}
                  showExpose={showExpose}
                  expanded={expanded === r.runUid}
                  onToggle={() => setExpanded((cur) => (cur === r.runUid ? null : r.runUid))}
                />
              ))}
            </div>
          ))}
          {hasMore && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="mt-2 flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card/40 px-3 py-2 text-[12px] text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-60"
            >
              {loadingMore && <Loader2 className="size-3.5 animate-spin" />}
              {t("runHistory.loadMore")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RunRow({
  run,
  t,
  labels,
  durLabels,
  showExpose,
  expanded,
  onToggle,
}: {
  run: OperationRun;
  t: (k: string | string[], opts?: Record<string, unknown>) => string;
  labels: RunLabels;
  durLabels: { h: string; m: string; s: string };
  showExpose: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const op = operationKind(run.opType);
  const Icon = op.icon;
  const rel = relativeTime(run.startedAt);
  const dur =
    run.endedAt != null
      ? formatDuration(Math.max(0, run.endedAt - run.startedAt), durLabels)
      : null;
  const meta = runMetaLine(run, { holes: labels.holes, tools: labels.tools });
  const drill = run.opType === "drill" ? parseDrillParams(run.paramsJson) : null;
  const canRepeat = OPENABLE.has(run.opType) && (run.opType !== "expose" || showExpose);

  return (
    <div className="rounded-[10px] border border-border/70 bg-card/60">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-card"
      >
        <div className={`grid size-[34px] shrink-0 place-items-center rounded-[9px] ${op.tile}`}>
          <Icon className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-foreground">
            {labels.typeLabel(run.opType)}
          </div>
          {meta && (
            <div className="mt-0.5 text-[11.5px] text-muted-foreground tabular-nums">{meta}</div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusPill outcome={run.outcome} t={t} />
          <span className="text-[11px] text-muted-foreground/80 tabular-nums">
            {t(rel.key, rel.params)}
            {dur ? ` · ${dur}` : ""}
          </span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-border/60 px-3.5 py-2.5">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
            {run.progressTotal != null && (
              <Row
                label={t("runHistory.holesLabel")}
                value={
                  run.progressDone < run.progressTotal
                    ? `${run.progressDone} / ${run.progressTotal}`
                    : String(run.progressTotal)
                }
              />
            )}
            {drill?.toolCount != null && (
              <Row label={t("runHistory.toolsLabel")} value={String(drill.toolCount)} />
            )}
            {drill?.feedOverridePct != null && (
              <Row label={t("runHistory.feedLabel")} value={`${drill.feedOverridePct} %`} />
            )}
            {drill?.estimateSec != null && drill.estimateSec > 0 && (
              <Row
                label={t("runHistory.estimateLabel")}
                value={formatDuration(Math.round(drill.estimateSec), durLabels)}
              />
            )}
          </dl>
          {canRepeat && (
            <button
              type="button"
              onClick={() => void repeatRun(run)}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground transition-colors hover:border-primary/50 hover:bg-primary/10"
            >
              <RotateCcw className="size-3.5" />
              {t("runHistory.repeat")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums text-foreground">{value}</dd>
    </div>
  );
}

function StatusPill({
  outcome,
  t,
}: {
  outcome: string | null;
  t: (k: string) => string;
}) {
  const k = statusKey(outcome);
  if (k === "completed")
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-success">
        <CheckCircle2 className="size-3.5" />
        {t("runHistory.outcome.completed")}
      </span>
    );
  if (k === "stopped")
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-warning">
        <XCircle className="size-3.5" />
        {t("runHistory.outcome.stopped")}
      </span>
    );
  if (k === "interrupted")
    return (
      <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-destructive">
        <CircleSlash className="size-3.5" />
        {t("runHistory.outcome.interrupted")}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      {t("runHistory.outcome.running")}
    </span>
  );
}
