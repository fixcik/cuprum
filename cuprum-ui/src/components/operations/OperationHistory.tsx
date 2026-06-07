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

/** Drill summary parsed from params_json — only the bits the history row shows. */
function drillToolCount(paramsJson: string): number | null {
  try {
    const p = JSON.parse(paramsJson) as { toolCount?: number };
    return typeof p.toolCount === "number" ? p.toolCount : null;
  } catch {
    return null;
  }
}

/** Project-level operation history — every journalled run across all op types, newest
 *  first, filterable by type. Reads the global journal keyed on the saved project. */
export function OperationHistory() {
  const { t } = useTranslation("project");
  const currentPath = useShell((s) => s.currentPath);
  const [runs, setRuns] = useState<OperationRun[] | null>(null);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
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

  // Distinct op types present, for the filter chips.
  const types = useMemo(
    () => [...new Set((runs ?? []).map((r) => r.opType))],
    [runs],
  );
  const shown = useMemo(
    () => (filter === "all" ? (runs ?? []) : (runs ?? []).filter((r) => r.opType === filter)),
    [runs, filter],
  );

  const typeLabel = (op: string) => t([`runHistory.type.${op}`, "runHistory.type.unknown"], { op });

  if (!currentPath) {
    return (
      <div className="flex h-full w-full items-center justify-center text-[13px] text-muted-foreground">
        {t("runHistory.noProject")}
      </div>
    );
  }

  if (runs === null) {
    return (
      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Header + filter chips */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-widest text-muted-foreground">
          <HistoryIcon className="size-4" />
          {t("runHistory.title")}
        </div>
        {types.length > 0 && (
          <div className="flex items-center gap-1.5">
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

      {/* Rows */}
      {shown.length === 0 ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-muted-foreground">
          {t("runHistory.empty")}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-[12px]">
            <tbody>
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
                return (
                  <tr key={r.runUid} className="border-b border-border/60">
                    <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted-foreground">
                      {t(rel.key, rel.params)}
                    </td>
                    <td className="px-3 py-2 font-medium text-foreground">{typeLabel(r.opType)}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
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
                    </td>
                    <td className="px-3 py-2">
                      <OutcomeBadge outcome={r.outcome} t={t} />
                    </td>
                    <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted-foreground">
                      {dur ?? "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
      <span className="inline-flex items-center gap-1 text-success">
        <CheckCircle2 className="size-3.5" />
        {t("runHistory.outcome.completed")}
      </span>
    );
  }
  if (outcome === "stopped") {
    return (
      <span className="inline-flex items-center gap-1 text-warning">
        <XCircle className="size-3.5" />
        {t("runHistory.outcome.stopped")}
      </span>
    );
  }
  if (outcome === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-destructive">
        <XCircle className="size-3.5" />
        {t("runHistory.outcome.error")}
      </span>
    );
  }
  // No outcome yet → still running.
  return (
    <span className="inline-flex items-center gap-1 text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" />
      {t("runHistory.outcome.running")}
    </span>
  );
}
