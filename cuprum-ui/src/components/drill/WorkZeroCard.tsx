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
  LocateFixed,
} from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { useJog } from "@/hooks/useJog";
import { type XYGateResult, formatXYViolations } from "@/lib/xyGate";
import { JogStepControl } from "@/components/machine/JogStepControl";
import { ZTouchOffStrip } from "@/components/drill/ZTouchOffStrip";
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

/** axis → CSS var token for the readout/chip colour (`--axis-x/y/z`, shared with the DRO). */
const AXIS_VAR = { x: "var(--axis-x)", y: "var(--axis-y)", z: "var(--axis-z)" };

/** Hero XY jog pad arrow button — full-width, tall, so the pad reads as the primary action. */
const padBtn =
  "flex h-[50px] w-full items-center justify-center rounded-lg border border-border bg-muted/45 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground active:translate-y-px disabled:pointer-events-none disabled:opacity-30";

/** Centre "go to work zero" button — primary-tinted to read as the origin/seek target. */
const centerBtn =
  "flex h-[50px] w-full items-center justify-center rounded-lg border border-primary/50 bg-primary/15 text-primary transition-colors hover:bg-primary/25 disabled:pointer-events-none disabled:opacity-30";

/** Work-zero jog body (Variant B): the X/Y machine readout as instrument chips on top,
 *  a step selector, the hero 3×3 XY jog pad (the only action that binds here — Z is
 *  probed per-bit), and a secondary "Z touch-off" card carrying a horizontal Z strip to
 *  lower the spindle for aiming. The bind/reset actions live in the inspector's sticky
 *  footer (DrillZeroInspector), not here. */
export function WorkZeroCard({ workZeroSet, maxXMm, maxYMm, maxZMm, xyGate }: WorkZeroCardProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  // Live MPos readout.
  const mposX = useMachine((s) => s.status.mpos[0]);
  const mposY = useMachine((s) => s.status.mpos[1]);
  const mposZ = useMachine((s) => s.status.mpos[2]);

  // Machine-frame clamp for the XY pad: X,Y travel from 0 to max. Z is jogged from the
  // touch-off strip (its own clamp), not the pad, so its bound here is inert.
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

  // Big "instrument" readout: axis chip + live value split into number + unit (so the
  // unit reads small, like the manual DRO). Split on the first space — works for metric
  // ("94.33 мм") and falls back gracefully for imperial glyph units.
  const readout = (axis: "x" | "y", value: number) => {
    const s = fmtLen(value);
    const sp = s.indexOf(" ");
    const num = sp === -1 ? s : s.slice(0, sp);
    const unit = sp === -1 ? "" : s.slice(sp + 1);
    return (
      <div className="flex items-center gap-2.5">
        <span
          className="grid size-[30px] shrink-0 place-items-center rounded-[7px] text-[13px] font-bold text-background"
          style={{ background: `hsl(${AXIS_VAR[axis]})` }}
        >
          {axis.toUpperCase()}
        </span>
        <div className="flex items-baseline gap-1.5">
          <span
            className="font-mono text-[22px] font-semibold tabular-nums leading-none text-foreground"
            style={{ letterSpacing: "-0.02em" }}
          >
            {num}
          </span>
          {unit && <span className="text-[12px] text-muted-foreground">{unit}</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4 border-b border-border p-4 text-sm">
      {/* Instrument X/Y readouts (Z lives in the touch-off card below) */}
      <div className="flex items-center justify-between gap-2">
        {readout("x", mposX)}
        {readout("y", mposY)}
      </div>

      {/* "ПОДВОД ПО XY" + step selector */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
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

      {/* Hero 3×3 XY jog pad — the only thing bound on this screen */}
      <div className="grid grid-cols-3 gap-2">
        {dirBtn(-1, 1, "↖", <ArrowUpLeft className="size-5" />)}
        {dirBtn(0, 1, "Y+", <ArrowUp className="size-5" />)}
        {dirBtn(1, 1, "↗", <ArrowUpRight className="size-5" />)}
        {dirBtn(-1, 0, "X−", <ArrowLeft className="size-5" />)}
        <button
          type="button"
          title={t("workzero.gotoZero")}
          disabled={!enabled}
          className={centerBtn}
          onClick={() => void jogTo({ x: 0, y: 0 })}
        >
          <LocateFixed className="size-[22px]" />
        </button>
        {dirBtn(1, 0, "X+", <ArrowRight className="size-5" />)}
        {dirBtn(-1, -1, "↙", <ArrowDownLeft className="size-5" />)}
        {dirBtn(0, -1, "Y−", <ArrowDown className="size-5" />)}
        {dirBtn(1, -1, "↘", <ArrowDownRight className="size-5" />)}
      </div>

      {/* Z touch-off card — Z is demoted: it's aimed here but bound per-bit at run time */}
      <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted/30 p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className="grid size-[26px] place-items-center rounded-md text-[12px] font-bold text-background"
              style={{ background: `hsl(${AXIS_VAR.z})` }}
            >
              Z
            </span>
            <span className="text-[12px] text-foreground">{t("workzero.zTouchTitle")}</span>
          </div>
          <span className="font-mono text-[19px] tabular-nums text-foreground">{fmtLen(mposZ)}</span>
        </div>
        <ZTouchOffStrip maxZMm={maxZMm} />
        <p className="text-[11px] leading-relaxed text-muted-foreground">{t("workzero.zTouchHint")}</p>
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
    </div>
  );
}
