import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";

export interface DrillFinishCardProps {
  holesTotal: number;
  elapsedSec: number;
  onDone: () => void;
}

function fmtMmSs(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function DrillFinishCard({ holesTotal, elapsedSec, onDone }: DrillFinishCardProps) {
  const { t } = useTranslation("drill");

  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-3 mx-4 mb-3 flex flex-col gap-3">
      <p className="text-[13px] font-semibold text-primary">
        {t("finish.title", { count: holesTotal, time: fmtMmSs(elapsedSec) })}
      </p>
      <Button size="sm" variant="outline" className="w-full" onClick={onDone}>
        {t("finish.dismiss")}
      </Button>
    </div>
  );
}
