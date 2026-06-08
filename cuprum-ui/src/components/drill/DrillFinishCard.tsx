import { useTranslation } from "react-i18next";
import { CheckCheck } from "lucide-react";

export interface DrillFinishCardProps {
  holesTotal: number;
  elapsedSec: number;
}

function fmtMmSs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Green run-complete summary (the «Готово» action lives in the footer). */
export function DrillFinishCard({ holesTotal, elapsedSec }: DrillFinishCardProps) {
  const { t } = useTranslation("drill");

  return (
    <div className="mx-3 mb-3 flex items-center gap-2.5 rounded-xl border border-primary/40 bg-primary/[0.07] px-3 py-3">
      <div className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
        <CheckCheck className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-foreground">{t("finish.heading")}</div>
        <div className="text-[11px] text-muted-foreground">
          {t("summary.holes", { count: holesTotal })} · {fmtMmSs(elapsedSec)}
        </div>
      </div>
    </div>
  );
}
