import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, XCircle, Loader2, History as HistoryIcon } from "lucide-react";
import { api, type OperationRun } from "@/lib/api";
import { useShell } from "@/shellStore";
import { relativeTime } from "@/i18n/relativeTime";

/** Compact duration ("Xm Ys" / "Ys") from whole seconds. */
function formatDuration(sec: number, minShort: string, secShort: string): string {
  if (sec < 60) return `${sec}${secShort}`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}${minShort} ${s}${secShort}` : `${m}${minShort}`;
}

/** Distinct tool count parsed from a drill run's params_json (history summary). */
function drillToolCount(paramsJson: string): number | null {
  try {
    const p = JSON.parse(paramsJson) as { toolCount?: number };
    return typeof p.toolCount === "number" ? p.toolCount : null;
  } catch {
    return null;
  }
}

/** Op types that have a window to (re)open from a history card. */
const OPENABLE: Record<string, () => void> = {
  drill: () => void api.openDrillWindow(),
};

/** Operation history as a card list — every journalled run across all op types,
 *  newest first, filterable by type. Lives in the Operations view beside the
 *  operation buttons; clicking a run reopens its operation window. */
export function OperationHistory() {
  const { t } = useTranslation("project");
  const currentPath = useShell((s) => s.currentPath);
  const [runs, setRuns] = useState<OperationRun[] | null>(null);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    // Reset the type filter on project change — a stale filter could hide the new
    // project's runs behind an empty state.
    setFilter("all");
    if (!currentPath) {
      setRuns([]);
      return;
    }
    let active = true;
    void api.operationLog
      .list(currentPath)
      .then((rows) => {
        if (active) setRuns(rows);
      })
      .catch(() => {
        if (active) setRuns([]);
      });
    return () => {
      active = false;
    };
  }, [currentPath]);

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
          {shown.map((r) => {
            const rel = relativeTime(r.startedAt);
            const dur =
              r.endedAt != null
                ? formatDuration(
                    Math.max(0, r.endedAt - r.startedAt),
                    t("runHistory.minShort"),
                    t("runHistory.secShort"),
                  )
                : null;
            const tools = r.opType === "drill" ? drillToolCount(r.paramsJson) : null;
            const open = OPENABLE[r.opType];
            const summary = (
              <>
                {r.progressTotal != null && (
                  <span>
                    {t("runHistory.holesLabel")} {r.progressTotal}
                  </span>
                )}
                {tools != null && (
                  <span>
                    {" · "}
                    {t("runHistory.toolsLabel")} {tools}
                  </span>
                )}
              </>
            );
            return (
              <RunCard
                key={r.runUid}
                onOpen={open}
                title={typeLabel(r.opType)}
                outcome={<OutcomeBadge outcome={r.outcome} t={t} />}
                summary={summary}
                meta={`${t(rel.key, rel.params)}${dur ? ` · ${dur}` : ""}`}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

/** A single history card — a button when the op can be reopened, else a plain box. */
function RunCard({
  onOpen,
  title,
  outcome,
  summary,
  meta,
}: {
  onOpen?: () => void;
  title: string;
  outcome: React.ReactNode;
  summary: React.ReactNode;
  meta: string;
}) {
  const inner = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-medium text-foreground">{title}</span>
        {outcome}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="tabular-nums">{summary}</span>
        <span className="shrink-0 tabular-nums">{meta}</span>
      </div>
    </>
  );
  const base = "rounded-lg border border-border bg-card/50 px-3 py-2 text-left";
  return onOpen ? (
    <button
      type="button"
      onClick={onOpen}
      className={`${base} w-full transition-colors hover:border-primary/50 hover:bg-card`}
    >
      {inner}
    </button>
  ) : (
    <div className={base}>{inner}</div>
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
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      {t("runHistory.outcome.running")}
    </span>
  );
}
