import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";

const AXES = ["X", "Y", "Z"] as const;

export function Dro() {
  const { t } = useTranslation("machine");
  const status = useMachine((s) => s.status);
  const connected = useMachine((s) => s.connected);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="grid grid-cols-[2rem_1fr_1fr_auto] items-center gap-x-3 gap-y-1.5">
        <div />
        <div className="text-right text-xs text-muted-foreground">{t("dro.work")}</div>
        <div className="text-right text-xs text-muted-foreground">{t("dro.machine")}</div>
        <div />
        {AXES.map((axis, i) => (
          <div key={axis} className="contents">
            <div className="text-sm font-semibold text-muted-foreground">{axis}</div>
            <div className="text-right font-mono text-lg tabular-nums">{status.wpos[i].toFixed(3)}</div>
            <div className="text-right font-mono text-sm tabular-nums text-muted-foreground">{status.mpos[i].toFixed(3)}</div>
            <Button
              variant="ghost"
              size="sm"
              disabled={!connected}
              onClick={() => void api.machine.setZero(i === 0, i === 1, i === 2)}
            >
              {t("dro.zeroAxis", { axis })}
            </Button>
          </div>
        ))}
      </div>
      <Button
        className="mt-3 w-full"
        variant="secondary"
        disabled={!connected}
        onClick={() => void api.machine.setZero(true, true, true)}
      >
        {t("dro.zeroAll")}
      </Button>
    </div>
  );
}
