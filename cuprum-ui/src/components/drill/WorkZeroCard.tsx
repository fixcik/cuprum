import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Crosshair,
} from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { useJog } from "@/hooks/useJog";
import { machineZFromFraction } from "@/lib/zbar";
import { checkZGate } from "@/lib/zGate";
import { type XYGateResult, formatXYViolations } from "@/lib/xyGate";
import { JogStepControl } from "@/components/machine/JogStepControl";
import { useUnitFormat } from "@/i18n/useUnitFormat";

export interface WorkZeroCardProps {
  /** MPos Z captured at bind (null = not bound). Drives the Z gate. */
  workZeroMachineZ: number | null;
  safeZMm: number;
  /** Machine travel (mm, positive) per axis — source for the machine-frame clamp. */
  maxXMm: number;
  maxYMm: number;
  maxZMm: number;
  /** XY gate result (hole bbox vs machine envelope) — drives the XY overrun banner. */
  xyGate: XYGateResult;
}

/** Shared button style for the XY jog pad arrows. */
const padBtn =
  "flex h-8 w-full items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground active:bg-primary/10 disabled:pointer-events-none disabled:opacity-30";

/** Small square button style for the Z± controls beside the Z scale. */
const zBtn =
  "grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground transition-all hover:border-primary/50 hover:text-foreground active:scale-95 active:text-primary disabled:opacity-30 disabled:pointer-events-none";

/** Machine-frame jog body for binding the work zero: a three-axis DRO, an XY pad,
 *  a compact clickable Z scale with Z± buttons, a step selector, the bound-zero /
 *  retract-preview status line, and the amber Z/XY gate banners. The bind/reset
 *  actions live in the inspector's sticky footer (DrillZeroInspector), not here. */
export function WorkZeroCard({
  workZeroMachineZ,
  safeZMm,
  maxXMm,
  maxYMm,
  maxZMm,
  xyGate,
}: WorkZeroCardProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  // Live MPos readout for the three-axis DRO.
  const mposX = useMachine((s) => s.status.mpos[0]);
  const mposY = useMachine((s) => s.status.mpos[1]);
  const mposZ = useMachine((s) => s.status.mpos[2]);

  // Machine-frame clamp: X,Y travel from 0 to max; Z from -max to 0 (ceiling = 0).
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

  // Z gate check — drives the amber banner.
  const gate = checkZGate(workZeroMachineZ, safeZMm);

  // --- Compact clickable Z scale ---
  // wcoZ = MPos − WPos; used to convert click targets to work-coordinate deltas for jogTo.
  const wposZ = useMachine((s) => s.status.wpos[2]);
  const wcoZ = mposZ - wposZ;

  // Height of the compact Z scale track.
  const TRACK_H = 120;
  const range = maxZMm || 1;
  // Fill fraction: tool distance from the floor (-maxZMm) expressed as a fraction
  // of the travel, clamped to [2%, 100%] so the fill bar always has a visible sliver.
  const fillPct = Math.max(2, ((mposZ - -maxZMm) / range) * 100);

  // Work-zero tick position (where the user bound the zero inside the scale).
  const wcoFromFloor = (wcoZ - -maxZMm) / range;
  const zeroPct = Math.min(100, Math.max(0, wcoFromFloor * 100));

  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ workZ: number; topPct: number } | null>(null);

  /** Fraction of the Z track that the cursor is at, measured from the bottom. */
  const fracFromBottom = (clientY: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return 1 - (clientY - r.top) / r.height;
  };

  const onTrackClick = (e: React.MouseEvent) => {
    if (!enabled) return;
    const targetMachineZ = machineZFromFraction(fracFromBottom(e.clientY), maxZMm);
    // jogTo expects work coordinates; convert from machine Z via the LIVE WCO read
    // at click time (a rebind changes WCO and the render snapshot may be stale).
    const { mpos, wpos } = useMachine.getState().status;
    void jogTo({ z: targetMachineZ - (mpos[2] - wpos[2]) });
  };

  const onTrackMove = (e: React.MouseEvent) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const targetMachineZ = machineZFromFraction(fracFromBottom(e.clientY), maxZMm);
    setHover({
      workZ: targetMachineZ - wcoZ,
      topPct: ((e.clientY - r.top) / r.height) * 100,
    });
  };

  // Z± button event props: step-click or press-hold continuous, mirroring ZBar.
  const zProps = (dz: number) =>
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

      {/* Three-axis DRO: MPos X / Y / Z */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{t("workzero.xLabel")}</span>
          <span className="font-mono text-[13px] tabular-nums text-foreground">{fmtLen(mposX)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{t("workzero.yLabel")}</span>
          <span className="font-mono text-[13px] tabular-nums text-foreground">{fmtLen(mposY)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">{t("workzero.zLabel")}</span>
          <span className="font-mono text-[13px] tabular-nums text-foreground">{fmtLen(mposZ)}</span>
        </div>
      </div>

      {/* Jog controls: XY 3×3 pad on the left, compact Z column on the right */}
      <div className="flex items-start gap-4">
        {/* XY 3×3 jog pad (132 px wide) */}
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

        {/* Compact Z column: Z+ button / slim clickable scale / Z− button */}
        <div className="flex flex-col items-center gap-1">
          <span className="text-[10px] font-semibold uppercase text-axis-z">Z</span>
          <button
            type="button"
            title={`Z+ ${fmtLen(typeof step === "number" ? step : 0)}`}
            disabled={!enabled}
            className={zBtn}
            {...zProps(1)}
          >
            <ChevronUp className="size-4" />
          </button>

          {/* Slim clickable Z scale track */}
          <div className="relative flex w-full justify-center" style={{ height: TRACK_H }}>
            <div
              ref={trackRef}
              onClick={onTrackClick}
              onMouseMove={onTrackMove}
              onMouseLeave={() => setHover(null)}
              className={`relative w-2.5 overflow-hidden rounded-full bg-muted ${enabled ? "cursor-pointer" : ""}`}
              style={{ height: TRACK_H }}
            >
              {/* Fill bar: rises from the floor as the tool descends */}
              <div
                className="absolute inset-x-0 bottom-0 rounded-full bg-axis-z/70"
                style={{ height: `${fillPct}%` }}
              />
              {/* Work-zero tick mark */}
              <div
                className="absolute inset-x-[-3px] h-[1.5px] bg-primary"
                style={{ bottom: `${zeroPct}%` }}
              />
            </div>

            {/* Hover tooltip: target work Z */}
            {hover && enabled && (
              <div
                className="pointer-events-none absolute right-full mr-1.5 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-popover/90 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground backdrop-blur"
                style={{ top: `${hover.topPct}%` }}
              >
                → Z{hover.workZ.toFixed(1)}
              </div>
            )}
          </div>

          <button
            type="button"
            title={`Z− ${fmtLen(typeof step === "number" ? step : 0)}`}
            disabled={!enabled}
            className={zBtn}
            {...zProps(-1)}
          >
            <ChevronDown className="size-4" />
          </button>
        </div>
      </div>

      {/* Step selector */}
      <JogStepControl
        steps={steps}
        step={step}
        setStep={setStep}
        continuous={continuous}
        onBeforeChange={stopContinuous}
      />

      {/* Status line: bound (captured Z + retract preview) or not-bound hint */}
      {workZeroMachineZ !== null ? (
        <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
          <div className="flex items-center gap-1.5 text-emerald-400">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>{t("workzero.set")}</span>
          </div>
          <span>
            {t("workzero.zMachine")}: {fmtLen(workZeroMachineZ)}
          </span>
          <span>
            {t("workzero.retract")}: {fmtLen(workZeroMachineZ + safeZMm)} (safe-Z +{fmtLen(safeZMm)})
          </span>
        </div>
      ) : (
        <p className="text-[11px] text-muted-foreground/60">{t("workzero.notZeroedHint")}</p>
      )}

      {/* Amber gate banner: safe-Z retract would exceed the machine ceiling */}
      {gate.valid === false && gate.reason === "too-high" && (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("workzero.tooHigh")}</span>
        </div>
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
