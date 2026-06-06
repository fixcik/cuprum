import { useTranslation } from "react-i18next";
import { AlertTriangle, ChevronDown, ChevronUp, Crosshair } from "lucide-react";
import { useMachine } from "@/machineStore";
import { api, type MachineStateName } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { checkZGate } from "@/lib/zGate";
import { Button } from "@/components/ui/Button";

export interface ZTouchOffCardProps {
  connected: boolean;
  machineState: MachineStateName;
  workZeroMachineZ: number | null;
  safeZMm: number;
  jogStepsMm: number[];
  jogFeedMmMin: number;
  onTouchOff: () => void;
  onClear: () => void;
}

/** Z touch-off card: micro jog buttons, bind-to-copper action, retract preview,
 *  and an amber banner when the safe-Z retract would exceed the machine ceiling. */
export function ZTouchOffCard({
  connected,
  machineState,
  workZeroMachineZ,
  safeZMm,
  jogStepsMm,
  jogFeedMmMin,
  onTouchOff,
  onClear,
}: ZTouchOffCardProps) {
  const { t } = useTranslation("drill");
  // Subscribe to live MPos Z for the DRO readout.
  const mposZ = useMachine((s) => s.status.mpos[2]);
  const moveable = canMove(machineState, connected);

  // Use the smallest available jog step for fine Z positioning.
  const step = jogStepsMm[0] ?? 0.1;

  const gate = checkZGate(workZeroMachineZ, safeZMm);

  return (
    <div className="flex flex-col gap-3 border-b border-border p-4 text-sm">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Crosshair className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-[13px] font-semibold text-foreground">{t("ztouch.title")}</span>
      </div>

      {/* Hint */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("ztouch.hint")}</p>

      {/* Live MPos Z DRO */}
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted-foreground">{t("ztouch.zLabel")}</span>
        <span className="font-mono text-[13px] tabular-nums text-foreground">
          {mposZ.toFixed(2)} мм
        </span>
      </div>

      {/* Micro Z-jog buttons */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          title={`Z+ ${step} мм`}
          disabled={!moveable}
          onClick={() => void api.machine.jog(0, 0, step, jogFeedMmMin)}
          className="flex h-8 w-14 items-center justify-center gap-1 rounded-md border border-border bg-background text-[12px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground active:bg-primary/10 disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronUp className="h-3.5 w-3.5 shrink-0" />
          <span>Z+</span>
        </button>
        <button
          type="button"
          title={`Z− ${step} мм`}
          disabled={!moveable}
          onClick={() => void api.machine.jog(0, 0, -step, jogFeedMmMin)}
          className="flex h-8 w-14 items-center justify-center gap-1 rounded-md border border-border bg-background text-[12px] font-medium text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground active:bg-primary/10 disabled:pointer-events-none disabled:opacity-30"
        >
          <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          <span>Z−</span>
        </button>
        <span className="text-[10px] text-muted-foreground/60">{step} мм/шаг</span>
      </div>

      {/* Touch-off + clear actions */}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!moveable} onClick={onTouchOff}>
          {t("ztouch.touchOff")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={workZeroMachineZ === null}
          onClick={onClear}
        >
          {t("ztouch.reset")}
        </Button>
      </div>

      {/* Captured zero + retract preview */}
      {workZeroMachineZ !== null && (
        <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
          <span>
            {t("ztouch.zLabel")} (станок): {workZeroMachineZ.toFixed(2)} мм
          </span>
          <span>
            Отвод: {(workZeroMachineZ + safeZMm).toFixed(2)} мм (safe-Z +{safeZMm} мм)
          </span>
        </div>
      )}

      {/* Warning banner when retract exceeds ceiling */}
      {gate.valid === false && gate.reason === "too-high" && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("ztouch.tooHigh")}</span>
        </div>
      )}

      {/* Not-zeroed hint when no touch-off captured yet */}
      {workZeroMachineZ === null && (
        <p className="text-[11px] text-muted-foreground/60">{t("ztouch.notZeroed")}</p>
      )}
    </div>
  );
}
