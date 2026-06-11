import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  XCircle,
  CircleSlash,
  Loader2,
  History as HistoryIcon,
  RotateCcw,
} from "lucide-react";
import { api, type OperationRun } from "@/lib/api";
import { useShell } from "@/shellStore";
import { relativeTime } from "@/i18n/relativeTime";

/** Runs fetched per page; "load more" appends the next page. */
const PAGE_SIZE = 20;

/** Compact duration ("Xm Ys" / "Ys") from whole seconds. */
function formatDuration(sec: number, minShort: string, secShort: string): string {
  if (sec < 60) return `${sec}${secShort}`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}${minShort} ${s}${secShort}` : `${m}${minShort}`;
}

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

/** Operation history as a card list — every journalled run across all op types,
 *  newest first, paginated and filterable. Lives in the Operations view beside the
 *  operation buttons; a card expands to read-only run details with a "repeat" action. */
export function OperationHistory() {
  const { t } = useTranslation("project");
  const currentPath = useShell((s) => s.currentPath);
  const [runs, setRuns] = useState<OperationRun[] | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // First page on project change (resets filter/expansion so stale state can't hide
  // the new project's runs).
  useEffect(() => {
    setFilter("all");
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

  const types = useMemo(() => [...new Set((runs ?? []).map((r) => r.opType))], [runs]);
  const shown = useMemo(
    () => (filter === "all" ? (runs ?? []) : (runs ?? []).filter((r) => r.opType === filter)),
    [runs, filter],
  );

  const typeLabel = (op: string) => t([`runHistory.type.${op}`, "runHistory.type.unknown"], { op });

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header + filter chips */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          <HistoryIcon className="size-3.5" />
          {t("runHistory.title")}
        </div>
        {types.length > 1 && (
          <div className="flex items-center gap-1">
            {["all", ...types].map((op) => (
              <button
                key={op}
                type="button"
                onClick={() => setFilter(op)}
                className={`rounded-md px-2 py-0.5 text-[11px] ${
                  filter === op
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                }`}
              >
                {op === "all" ? t("runHistory.filterAll") : typeLabel(op)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Card list */}
      {runs === null ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : !currentPath ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[12px] text-muted-foreground">
          {t("runHistory.noProject")}
        </div>
      ) : shown.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 text-center text-[12px] text-muted-foreground">
          {t("runHistory.empty")}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
          {shown.map((r) => (
            <RunCard
              key={r.runUid}
              run={r}
              t={t}
              typeLabel={typeLabel}
              expanded={expanded === r.runUid}
              onToggle={() => setExpanded((cur) => (cur === r.runUid ? null : r.runUid))}
            />
          ))}
          {hasMore && (
            <button
              type="button"
              onClick={loadMore}
              disabled={loadingMore}
              className="mt-1 flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card/40 px-3 py-2 text-[12px] text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-60"
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

function RunCard({
  run,
  t,
  typeLabel,
  expanded,
  onToggle,
}: {
  run: OperationRun;
  t: (k: string | string[], opts?: Record<string, unknown>) => string;
  typeLabel: (op: string) => string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const rel = relativeTime(run.startedAt);
  const minShort = t("runHistory.minShort");
  const secShort = t("runHistory.secShort");
  const dur =
    run.endedAt != null
      ? formatDuration(Math.max(0, run.endedAt - run.startedAt), minShort, secShort)
      : null;
  const drill = run.opType === "drill" ? parseDrillParams(run.paramsJson) : null;
  const canRepeat = OPENABLE.has(run.opType);

  return (
    <div className="rounded-lg border border-border bg-card/50">
      {/* Header row — toggles the detail */}
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-2 text-left transition-colors hover:bg-card"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-foreground">{typeLabel(run.opType)}</span>
          <OutcomeBadge outcome={run.outcome} t={t} />
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {run.progressTotal != null && (
              <span>
                {t("runHistory.holesLabel")} {run.progressTotal}
              </span>
            )}
            {drill?.toolCount != null && (
              <span>
                {" · "}
                {t("runHistory.toolsLabel")} {drill.toolCount}
              </span>
            )}
          </span>
          <span className="shrink-0 tabular-nums">
            {t(rel.key, rel.params)}
            {dur ? ` · ${dur}` : ""}
          </span>
        </div>
      </button>

      {/* Read-only detail */}
      {expanded && (
        <div className="border-t border-border/60 px-3 py-2">
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
                value={formatDuration(Math.round(drill.estimateSec), minShort, secShort)}
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

function OutcomeBadge({
  outcome,
  t,
}: {
  outcome: string | null;
  t: (k: string) => string;
}) {
  if (outcome === "completed") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-success">
        <CheckCircle2 className="size-3.5" />
        {t("runHistory.outcome.completed")}
      </span>
    );
  }
  if (outcome === "stopped") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-warning">
        <XCircle className="size-3.5" />
        {t("runHistory.outcome.stopped")}
      </span>
    );
  }
  if (outcome === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-destructive">
        <XCircle className="size-3.5" />
        {t("runHistory.outcome.error")}
      </span>
    );
  }
  if (outcome === "interrupted") {
    // Orphaned run: its window closed mid-run, reconciled at the next project open.
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <CircleSlash className="size-3.5" />
        {t("runHistory.outcome.interrupted")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      {t("runHistory.outcome.running")}
    </span>
  );
}
