import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";

export function SpindleControl() {
  const { t } = useTranslation("machine");
  const cnc = useSettings((s) => s.cncProfile);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const spindle = useMachine((s) => s.status.spindle);
  const enabled = canMove(state, connected);

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{t("spindle.title")}</span>
        <span className="font-mono text-sm tabular-nums">{spindle.toFixed(0)} {t("spindle.rpm")}</span>
      </div>
      <div className="flex gap-2">
        <Button disabled={!enabled} onClick={() => void api.machine.spindle(true, cnc.spindleMaxRpm)}>
          {t("spindle.on")}
        </Button>
        <Button variant="secondary" disabled={!connected} onClick={() => void api.machine.spindle(false, 0)}>
          {t("spindle.off")}
        </Button>
      </div>
    </div>
  );
}
