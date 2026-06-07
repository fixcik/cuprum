import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Crosshair,
} from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { useJog } from "@/hooks/useJog";
import { type XYGateResult, formatXYViolations } from "@/lib/xyGate";
import { AlertTriangle } from "lucide-react";
import { JogStepControl } from "@/components/machine/JogStepControl";
import { useUnitFormat } from "@/i18n/useUnitFormat";

export interface WorkZeroCardProps {
  /** Whether the XY work zero has been bound. Drives the "zero set" status line. */
  workZeroSet: boolean;
  /** Machine travel (mm, positive) per axis — source for the machine-frame clamp. */
  maxXMm: number;
  maxYMm: number;
  /** XY gate result (hole bbox vs machine envelope) — drives the XY overrun banner. */
  xyGate: XYGateResult;
}

/** Shared button style for the XY jog pad arrows. */
const padBtn =
  "flex h-8 w-full items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground active:bg-primary/10 disabled:pointer-events-none disabled:opacity-30";

/** Machine-frame jog body for binding the work zero: a two-axis DRO (X/Y), an XY
 *  pad, a step selector, the bound-zero status line, the XY gate banner, and an
 *  informational note that Z is probed per-bit. The bind/reset actions live in the
 *  inspector's sticky footer (DrillZeroInspector), not here. */
export function WorkZeroCard({
  workZeroSet,
  maxXMm,
  maxYMm,
  xyGate,
}: WorkZeroCardProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  // Live MPos readout for the two-axis DRO.
  const mposX = useMachine((s) => s.status.mpos[0]);
  const mposY = useMachine((s) => s.status.mpos[1]);

  // Machine-frame clamp: X,Y travel from 0 to max; z=[0,0] because Z jog is
  // no longer driven from this card (Z is probed per-bit at run time).
  const bounds = {
    x: [0, maxXMm] as [number, number],
    y: [0, maxYMm] as [number, number],
    z: [0, 0] as [number, number],
  };

  const { enabled, step, setStep, continuous, go, startContinuous, stopContinuous } =
    useJog({ bounds });

  // Stop any in-flight continuous jog on unmount.
  useEffect(() => () => stopContinuous(), [stopContinuous]);

  // Step config from settings (same source as JogPad and ZBar).
  const steps = useSettings((s) => s.cncProfile.jogStepsMm);

  // XY pad button event props: step-click or press-hold continuous.
  const xyProps = (dx: number, dy: number) =>
    continuous
      ? {
          onPointerDown: (e: React.PointerEvent) => {
            e.preventDefault();
            void startContinuous(dx, dy, 0);
          },
          onPointerUp: () => stopContinuous(),
          onPointerLeave: () => stopContinuous(),
          onPointerCancel: () => stopContinuous(),
        }
      : { onClick: () => go(dx, dy, 0) };

  return (
    <div className="flex flex-col gap-3 border-b border-border p-4 text-sm">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Crosshair className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="text-[13px] font-semibold text-foreground">{t("workzero.jogTitle")}</span>
      </div>

      {/* Hint */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("workzero.hint")}</p>

      {/* Two-axis DRO: MPos X / Y */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{t("workzero.xLabel")}</span>
          <span className="font-mono text-[13px] tabular-nums text-foreground">{fmtLen(mposX)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{t("workzero.yLabel")}</span>
          <span className="font-mono text-[13px] tabular-nums text-foreground">{fmtLen(mposY)}</span>
        </div>
      </div>

      {/* XY 3×3 jog pad */}
      <div className="grid w-[132px] grid-cols-3 gap-1.5">
        <span />
        <button
          type="button"
          title={`Y+ ${fmtLen(typeof step === "number" ? step : 0)}`}
          disabled={!enabled}
          className={padBtn}
          {...xyProps(0, 1)}
        >
          <ArrowUp className="h-4 w-4" />
        </button>
        <span />
        <button
          type="button"
          title={`X− ${fmtLen(typeof step === "number" ? step : 0)}`}
          disabled={!enabled}
          className={padBtn}
          {...xyProps(-1, 0)}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="grid place-items-center text-[9px] uppercase tracking-wide text-muted-foreground/50">
          {typeof step === "number" ? fmtLen(step) : "∞"}
        </span>
        <button
          type="button"
          title={`X+ ${fmtLen(typeof step === "number" ? step : 0)}`}
          disabled={!enabled}
          className={padBtn}
          {...xyProps(1, 0)}
        >
          <ArrowRight className="h-4 w-4" />
        </button>
        <span />
        <button
          type="button"
          title={`Y− ${fmtLen(typeof step === "number" ? step : 0)}`}
          disabled={!enabled}
          className={padBtn}
          {...xyProps(0, -1)}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
        <span />
      </div>

      {/* Step selector */}
      <JogStepControl
        steps={steps}
        step={step}
        setStep={setStep}
        continuous={continuous}
        onBeforeChange={stopContinuous}
      />

      {/* Status line: bound or not-bound hint */}
      {workZeroSet ? (
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>{t("workzero.set")}</span>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground/60">{t("workzero.notZeroedHint")}</p>
      )}

      {/* Amber gate banner: at this zero, the hole bbox overruns the XY travel */}
      {xyGate.valid === false && xyGate.reason === "out-of-bounds" && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("workzero.xyOutOfBounds", { detail: formatXYViolations(xyGate.violations, fmtLen) })}</span>
        </div>
      )}

      {/* Informational note: Z is probed per-bit, not set here */}
      <p className="text-[11px] leading-relaxed text-muted-foreground">{t("workzero.zPerToolNote")}</p>
    </div>
  );
}
