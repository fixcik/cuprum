import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { workZeroFromStatus } from "@/lib/workZero";
import { restoreWorkZero } from "@/lib/restoreWorkZero";

const AXES = ["X", "Y", "Z"] as const;

export function Dro() {
  const { t } = useTranslation("machine");
  const status = useMachine((s) => s.status);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const homingAvailable = useMachine((s) => s.homingAvailable);
  const cncProfile = useSettings((s) => s.cncProfile);
  const setCncProfile = useSettings((s) => s.setCncProfile);
  // Zeroing sets the WCS — GRBL rejects it outside Idle/Jog (e.g. Alarm), so gate
  // it with the same canMove() used for jog/home/spindle rather than just connected.
  const movable = canMove(state, connected);

  function handleSaveZero() {
    setCncProfile({ workZeroMm: workZeroFromStatus(status.mpos, status.wpos) });
  }

  function handleRestoreZero() {
    if (!cncProfile.workZeroMm) return;
    const z = cncProfile.workZeroMm;
    void (async () => {
      try {
        await restoreWorkZero(z);
      } catch (e) {
        useMachine.getState().pushLine({ dir: "rx", text: `restore failed: ${String(e)}` });
      }
    })();
  }

  const { workZeroMm } = cncProfile;
  const canRestore = connected && homingAvailable && workZeroMm !== null && movable;

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
              disabled={!movable}
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
        disabled={!movable}
        onClick={() => void api.machine.setZero(true, true, true)}
      >
        {t("dro.zeroAll")}
      </Button>

      {/* Work-zero save / restore row */}
      <div className="mt-3 flex gap-2">
        <Button
          className="flex-1"
          variant="ghost"
          size="sm"
          disabled={!movable}
          onClick={handleSaveZero}
        >
          {t("dro.saveZero")}
        </Button>
        <Button
          className="flex-1"
          variant="secondary"
          size="sm"
          disabled={!canRestore}
          onClick={handleRestoreZero}
        >
          {t("dro.restoreZero")}
        </Button>
      </div>

      {workZeroMm && (
        <div className="mt-1 text-xs text-muted-foreground">
          {t("dro.zeroSaved", { x: workZeroMm.x.toFixed(3), y: workZeroMm.y.toFixed(3) })}
        </div>
      )}

      {connected && !homingAvailable && workZeroMm && (
        <div className="mt-1 text-xs text-muted-foreground">
          {t("dro.homingUnavailable")}
        </div>
      )}
    </div>
  );
}
