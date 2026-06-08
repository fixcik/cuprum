import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Crosshair,
  Info,
} from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { useJog } from "@/hooks/useJog";
import { type XYGateResult, formatXYViolations } from "@/lib/xyGate";
import { JogStepControl } from "@/components/machine/JogStepControl";
import { useUnitFormat } from "@/i18n/useUnitFormat";

export interface WorkZeroCardProps {
  /** Whether the XY work zero has been bound. Drives the "zero set" status line. */
  workZeroSet: boolean;
  /** Machine travel (mm, positive) per axis — source for the machine-frame clamp. */
  maxXMm: number;
  maxYMm: number;
  /** Z travel (mm, positive). Z jog here only LOWERS the spindle to aim at the datum
   *  corner — it does NOT bind Z (that's probed per-bit). Clamp range is [-maxZMm, 0]. */
  maxZMm: number;
  /** XY gate result (hole bbox vs machine envelope) — drives the XY overrun banner. */
  xyGate: XYGateResult;
}

/** Axis colours from the design tokens (X red, Y green, Z blue) — used for the badges. */
const X_COLOR = "#d9534f";
const Y_COLOR = "#3fbf6f";
const Z_COLOR = "#4f8cd9";

/** Z± jog button — a tall bar segment that fills the pad height (matches the manual
 *  control's Z column), so the Z bar reads as a real control, not a tiny pair. */
const zBtn =
  "flex w-full flex-1 flex-col items-center justify-center gap-0.5 rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground active:bg-primary/10 disabled:pointer-events-none disabled:opacity-30";

/** Shared button style for the XY jog pad arrows. */
const padBtn =
  "flex h-9 w-full items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground active:bg-primary/10 disabled:pointer-events-none disabled:opacity-30";

/** Centre "go to work zero" button — primary-tinted to read as the origin. */
const centerBtn =
  "flex h-9 w-full items-center justify-center rounded-md border border-primary/50 bg-primary/10 text-primary transition-colors hover:bg-primary/20 disabled:pointer-events-none disabled:opacity-30";

/** Machine-frame jog body for binding the work zero: an 8-way XY pad with a centre
 *  go-to-zero, a Z± bar to lower the spindle for aiming (Z is NOT bound here — it's
 *  probed per-bit), the live X/Y/Z readout as coloured badges, a step selector in the
 *  header, the bound-zero status line, the XY gate banner, and an informational note
 *  that Z is probed per-bit. The bind/reset actions live in the inspector's sticky
 *  footer (DrillZeroInspector), not here. */
export function WorkZeroCard({ workZeroSet, maxXMm, maxYMm, maxZMm, xyGate }: WorkZeroCardProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  // Live MPos readout for the three-axis DRO.
  const mposX = useMachine((s) => s.status.mpos[0]);
  const mposY = useMachine((s) => s.status.mpos[1]);
  const mposZ = useMachine((s) => s.status.mpos[2]);

  // Machine-frame clamp: X,Y travel from 0 to max; Z from -max to the ceiling 0
  // (same convention as manual control). Z jog here only LOWERS the spindle to aim
  // at the datum corner — it does not bind Z (that's probed per-bit at run time).
  const bounds = {
    x: [0, maxXMm] as [number, number],
    y: [0, maxYMm] as [number, number],
    z: [-maxZMm, 0] as [number, number],
  };

  const { enabled, step, setStep, continuous, go, startContinuous, stopContinuous, jogTo } =
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

  // Z± button event props: step-click or press-hold continuous (mirrors xyProps).
  const zPropsFor = (dz: number) =>
    continuous
      ? {
          onPointerDown: (e: React.PointerEvent) => {
            e.preventDefault();
            void startContinuous(0, 0, dz);
          },
          onPointerUp: () => stopContinuous(),
          onPointerLeave: () => stopContinuous(),
          onPointerCancel: () => stopContinuous(),
        }
      : { onClick: () => go(0, 0, dz) };

  // One directional pad button. dx/dy ∈ {-1,0,1}.
  const dirBtn = (dx: number, dy: number, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      title={`${label} ${fmtLen(typeof step === "number" ? step : 0)}`}
      disabled={!enabled}
      className={padBtn}
      {...xyProps(dx, dy)}
    >
      {icon}
    </button>
  );

  const axisBadge = (label: string, color: string, value: number) => (
    <div className="flex items-center gap-2">
      <span
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-[12px] font-bold text-white"
        style={{ backgroundColor: color }}
      >
        {label}
      </span>
      <span className="font-mono text-[15px] tabular-nums text-foreground">{fmtLen(value)}</span>
    </div>
  );

  return (
    <div className="flex flex-col gap-3 border-b border-border p-4 text-sm">
      {/* Header: section label + step selector */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t("workzero.jogTitle")}
        </span>
        <JogStepControl
          steps={steps}
          step={step}
          setStep={setStep}
          continuous={continuous}
          onBeforeChange={stopContinuous}
        />
      </div>

      {/* 3×3 XY jog pad (left) + live X/Y/Z badges (centre) + Z± bar (right) */}
      <div className="flex items-stretch gap-4">
        <div className="grid w-[150px] grid-cols-3 gap-1.5">
          {dirBtn(-1, 1, "↖", <ArrowUpLeft className="h-4 w-4" />)}
          {dirBtn(0, 1, "Y+", <ArrowUp className="h-4 w-4" />)}
          {dirBtn(1, 1, "↗", <ArrowUpRight className="h-4 w-4" />)}
          {dirBtn(-1, 0, "X−", <ArrowLeft className="h-4 w-4" />)}
          <button
            type="button"
            title={t("workzero.gotoZero")}
            disabled={!enabled}
            className={centerBtn}
            onClick={() => void jogTo({ x: 0, y: 0 })}
          >
            <Crosshair className="h-4 w-4" />
          </button>
          {dirBtn(1, 0, "X+", <ArrowRight className="h-4 w-4" />)}
          {dirBtn(-1, -1, "↙", <ArrowDownLeft className="h-4 w-4" />)}
          {dirBtn(0, -1, "Y−", <ArrowDown className="h-4 w-4" />)}
          {dirBtn(1, -1, "↘", <ArrowDownRight className="h-4 w-4" />)}
        </div>

        {/* Live X/Y/Z machine readout, centred between the XY pad and the Z bar */}
        <div className="flex flex-1 flex-col justify-center gap-2.5">
          {axisBadge("X", X_COLOR, mposX)}
          {axisBadge("Y", Y_COLOR, mposY)}
          {axisBadge("Z", Z_COLOR, mposZ)}
        </div>

        {/* Z± bar — a tall column to lower/raise the spindle for aiming at the datum
            (does NOT bind Z). Fills the pad height so it reads as a real bar. */}
        <div className="flex w-[52px] flex-col gap-1.5">
          <button
            type="button"
            title={`Z+ ${fmtLen(typeof step === "number" ? step : 0)}`}
            disabled={!enabled}
            className={zBtn}
            {...zPropsFor(1)}
          >
            <ChevronUp className="h-5 w-5" />
            <span className="text-[10px] font-semibold">Z+</span>
          </button>
          <div className="grid place-items-center text-[9px] font-bold uppercase tracking-wide" style={{ color: Z_COLOR }}>
            Z
          </div>
          <button
            type="button"
            title={`Z− ${fmtLen(typeof step === "number" ? step : 0)}`}
            disabled={!enabled}
            className={zBtn}
            {...zPropsFor(-1)}
          >
            <span className="text-[10px] font-semibold">Z−</span>
            <ChevronDown className="h-5 w-5" />
          </button>
        </div>
      </div>

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
      <div className="flex items-start gap-2 rounded-md border border-border bg-background/40 px-3 py-2">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t("workzero.zPerToolNote")}</p>
      </div>
    </div>
  );
}
