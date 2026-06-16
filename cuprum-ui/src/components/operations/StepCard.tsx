import { useTranslation } from "react-i18next";
import { Play, Eye, CheckCircle2 } from "lucide-react";
import type { OperationKind } from "@/lib/operationKind";
import type { OperationRun } from "@/lib/api";
import { relativeTime } from "@/i18n/relativeTime";
import { formatDuration } from "@/lib/runHistoryFormat";

export function StepCard({
  op,
  lastRun,
  selected,
  onSelect,
}: {
  op: OperationKind;
  lastRun: OperationRun | null;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("project");
  const Icon = op.icon;
  const ready = op.mode === "ready";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`cursor-pointer rounded-xl border p-4 transition-colors ${
        selected
          ? "border-primary/60 bg-primary/[0.07]"
          : "border-border bg-card/60 hover:border-primary/40"
      }`}
    >
      <div className="flex items-start gap-3.5">
        <div className={`grid size-[50px] shrink-0 place-items-center rounded-xl ${op.tile}`}>
          <Icon className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[17px] font-bold text-foreground">{t(op.titleKey)}</span>
            <span
              className={`rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                ready ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
              }`}
            >
              {t(op.statusKey)}
            </span>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{t(op.descKey)}</p>
        </div>
      </div>

      <div className="mt-3.5 flex items-center justify-between gap-3 border-t border-border/60 pt-3">
        <LastRun run={lastRun} />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            void op.openWindow();
          }}
          className={`inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-semibold transition-colors ${
            ready
              ? "bg-primary text-primary-foreground hover:bg-primary/90"
              : "border border-border bg-muted text-foreground hover:bg-muted/70"
          }`}
        >
          {ready ? <Play className="size-3.5 fill-current" /> : <Eye className="size-3.5" />}
          {ready ? t("operations.run") : t("operations.preview")}
        </button>
      </div>
    </div>
  );
}

function LastRun({ run }: { run: OperationRun | null }) {
  const { t } = useTranslation("project");
  if (!run || run.endedAt == null) {
    return <span className="text-[11.5px] text-muted-foreground">{t("operations.neverRun")}</span>;
  }
  const rel = relativeTime(run.startedAt);
  const dur = formatDuration(Math.max(0, run.endedAt - run.startedAt), {
    h: t("runHistory.hourShort"),
    m: t("runHistory.minShort"),
    s: t("runHistory.secShort"),
  });
  return (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground tabular-nums">
      <CheckCircle2 className="size-3.5 text-success" />
      {t("operations.lastRun")} · {t(rel.key, rel.params)} · <span className="text-success">{dur}</span>
    </span>
  );
}
