import { useTranslation } from "react-i18next";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CheckCircle2, Crosshair } from "lucide-react";
import { useMachine } from "@/machineStore";
import { api, type MachineStateName } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { clampJogDelta, MIN_JOG_MM } from "@/lib/jogClamp";
import { Button } from "@/components/ui/Button";
import { useUnitFormat } from "@/i18n/useUnitFormat";

export interface XYZeroCardProps {
  connected: boolean;
  machineState: MachineStateName;
  /** Whether the work X-Y zero has been bound this session (ephemeral). */
  xySet: boolean;
  /** Machine X travel (mm). The X jog is clamped to [0, maxXMm] (homed corner = 0). */
  maxXMm: number;
  /** Machine Y travel (mm). The Y jog is clamped to [0, maxYMm]. */
  maxYMm: number;
  jogStepsMm: number[];
  jogFeedMmMin: number;
  onBind: () => void;
  onClear: () => void;
}

/** Work X-Y zero card: micro jog pad (X±/Y±), bind-to-datum-corner action, and a
 *  set/not-set indicator. Binding sends `G10 L20 P1 X0 Y0` so the run's G-code
 *  (work coords, origin = datum corner) maps onto the physical panel. */
export function XYZeroCard({
  connected,
  machineState,
  xySet,
  maxXMm,
  maxYMm,
  jogStepsMm,
  jogFeedMmMin,
  onBind,
  onClear,
}: XYZeroCardProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();
  // Subscribe to live MPos X/Y for the DRO readout.
  const mposX = useMachine((s) => s.status.mpos[0]);
  const mposY = useMachine((s) => s.status.mpos[1]);
  const moveable = canMove(machineState, connected);

  // Use the smallest available jog step for fine X-Y positioning.
  const step = jogStepsMm[0] ?? 0.1;

  // Clamp the X-Y micro-jog to the machine range [0, travel] from the live MPos,
  // so positioning can't drive into a limit (shared safeguard with the manual jog
  // pad). Read MPos live at click time, not from the render snapshot.
  const jogXY = (dx: 1 | -1 | 0, dy: 1 | -1 | 0) => {
    const mpos = useMachine.getState().status.mpos;
    const ax = clampJogDelta(dx * step, mpos[0], 0, maxXMm);
    const ay = clampJogDelta(dy * step, mpos[1], 0, maxYMm);
    if (Math.abs(ax) < MIN_JOG_MM && Math.abs(ay) < MIN_JOG_MM) return;
    void api.machine.jog(ax, ay, 0, jogFeedMmMin);
  };

  const padBtn =
    "flex h-8 w-full items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground active:bg-primary/10 disabled:pointer-events-none disabled:opacity-30";

  return (
    <div className="flex flex-col gap-3 border-b border-border p-4 text-sm">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Crosshair className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-[13px] font-semibold text-foreground">{t("xyzero.title")}</span>
      </div>

      {/* Hint */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("xyzero.hint")}</p>

      {/* Live MPos X/Y DRO */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{t("xyzero.xLabel")}</span>
          <span className="font-mono text-[13px] tabular-nums text-foreground">{fmtLen(mposX)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{t("xyzero.yLabel")}</span>
          <span className="font-mono text-[13px] tabular-nums text-foreground">{fmtLen(mposY)}</span>
        </div>
      </div>

      {/* Micro X-Y jog pad: 3×3 grid (Y+ top, X−/X+ middle, Y− bottom) */}
      <div className="grid w-[132px] grid-cols-3 gap-1.5">
        <span />
        <button type="button" title={`Y+ ${fmtLen(step)}`} disabled={!moveable} onClick={() => jogXY(0, 1)} className={padBtn}>
          <ArrowUp className="h-4 w-4" />
        </button>
        <span />
        <button type="button" title={`X− ${fmtLen(step)}`} disabled={!moveable} onClick={() => jogXY(-1, 0)} className={padBtn}>
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="grid place-items-center text-[9px] uppercase tracking-wide text-muted-foreground/50">
          {fmtLen(step)}
        </span>
        <button type="button" title={`X+ ${fmtLen(step)}`} disabled={!moveable} onClick={() => jogXY(1, 0)} className={padBtn}>
          <ArrowRight className="h-4 w-4" />
        </button>
        <span />
        <button type="button" title={`Y− ${fmtLen(step)}`} disabled={!moveable} onClick={() => jogXY(0, -1)} className={padBtn}>
          <ArrowDown className="h-4 w-4" />
        </button>
        <span />
      </div>

      {/* Bind + clear actions */}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!moveable} onClick={onBind}>
          {t("xyzero.bind")}
        </Button>
        <Button size="sm" variant="secondary" disabled={!xySet} onClick={onClear}>
          {t("xyzero.reset")}
        </Button>
      </div>

      {/* Set / not-set indicator */}
      {xySet ? (
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>{t("xyzero.set")}</span>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground/60">{t("xyzero.notSet")}</p>
      )}
    </div>
  );
}
