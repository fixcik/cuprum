import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Circle,
  Crosshair,
  RefreshCw,
  RotateCcw,
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
} from "lucide-react";
import { api, type FiducialDto, type FiducialStateDto } from "@/lib/api";
import type { DatumCorner } from "@/lib/datum";
import type { ToolingHole } from "@/lib/api";
import {
  buildFiducialEntries,
  fiducialCaptureBounds,
  classifyRms,
  canSolve,
  FIDUCIAL_CAPTURE_STEPS_MM,
  getRegistrationHoles,
} from "@/lib/fiducialRegistration";
import type { JogBounds } from "@/lib/jogBounds";
import { useJog, RAPID_JOG_FEED } from "@/hooks/useJog";
import { useMachine } from "@/machineStore";
import { canMove } from "@/lib/machineControls";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { Button } from "@/components/ui/Button";
import { JogStepControl } from "@/components/machine/JogStepControl";

export interface FiducialPanelProps {
  /** Registration tooling holes from the panel manifest. */
  toolingHoles: ToolingHole[];
  datum: DatumCorner;
  panelWidthMm: number;
  panelHeightMm: number;
  /** Machine travel envelope (used as outer clamp for fiducial capture box). */
  maxXMm: number;
  maxYMm: number;
  maxZMm: number;
  /** Navigate back to the plan inspector. */
  onBack: () => void;
}

/** Safe Z height (mm) to raise to before navigating XY toward a fiducial.
 *  Taken from the CNC safe-Z setting; fallback to 5 mm. */

/** Capture phase within a single fiducial workflow. */
type CapturePhase = "idle" | "raising-z" | "navigating-xy" | "lowering-z" | "ready-to-capture";

/** Inspector panel for fiducial-based registration. Shows each registration hole
 *  with its capture status, drives the jog (restricted envelope), and calls the
 *  fiducial_* commands. Lives in the DrillPlanInspector sidebar. */
export function FiducialPanel({
  toolingHoles,
  datum,
  panelWidthMm,
  panelHeightMm,
  maxXMm,
  maxYMm,
  maxZMm,
  onBack,
}: FiducialPanelProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();


  const machineState = useMachine((s) => s.status.state);
  const connected = useMachine((s) => s.connected);
  const enabled = canMove(machineState, connected);

  // Registration holes: extract once from props.
  const regHoles = getRegistrationHoles(toolingHoles);

  // Fiducial state from backend (polled after each action).
  const [fiducialState, setFiducialState] = useState<FiducialStateDto | null>(null);

  // Which fiducial index is actively being captured (null = none).
  const [activeIdx, setActiveIdx] = useState<number | null>(null);
  // Sub-phase of the capture workflow for active index.
  const [capturePhase, setCapturePhase] = useState<CapturePhase>("idle");

  // Error from the last fiducial command.
  const [error, setError] = useState<string | null>(null);

  // In-flight guard for async commands.
  const [busy, setBusy] = useState(false);

  // Machine bounds (full envelope) for intersecting with capture box.
  const machineBounds: JogBounds = {
    x: [0, maxXMm],
    y: [0, maxYMm],
    z: [-maxZMm, 0],
  };

  // Build ideal machine XY for each registration hole.
  const entries = buildFiducialEntries(regHoles, datum, panelWidthMm, panelHeightMm);

  // Derive jog bounds: restricted to capture box when a fiducial is active,
  // otherwise full machine envelope.
  const jogBounds: JogBounds =
    activeIdx !== null && entries[activeIdx]
      ? fiducialCaptureBounds(entries[activeIdx].ideal.x, entries[activeIdx].ideal.y, machineBounds)
      : machineBounds;

  // Jog hook with dynamic bounds. In capture mode only fine steps are allowed.
  const { step, setStep, continuous, go, startContinuous, stopContinuous, jogTo } = useJog({
    bounds: jogBounds,
  });

  // Force step to a fine value when entering capture mode.
  useEffect(() => {
    if (activeIdx !== null) {
      // Select the middle fine step (0.1 mm) as default capture step.
      const defaultStep = FIDUCIAL_CAPTURE_STEPS_MM[1] ?? FIDUCIAL_CAPTURE_STEPS_MM[0];
      if (typeof step !== "number" || !FIDUCIAL_CAPTURE_STEPS_MM.includes(step)) {
        setStep(defaultStep);
      }
    }
  }, [activeIdx, step, setStep]);

  // Stop continuous jog on unmount.
  useEffect(() => () => stopContinuous(), [stopContinuous]);

  // Initialize the backend fiducial list and fetch initial state on mount.
  const initDoneRef = useRef(false);
  useEffect(() => {
    if (regHoles.length === 0) return;
    if (initDoneRef.current) return;
    initDoneRef.current = true;

    void api.fiducial
      .init(entries)
      .then(() => api.fiducial.state())
      .then(setFiducialState)
      .catch((e: unknown) => {
        setError(String(e));
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run only once on mount

  const refreshState = useCallback(async () => {
    try {
      const st = await api.fiducial.state();
      setFiducialState(st);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  /** Start navigating to fiducial at `idx`: raise Z, then offer XY jog. */
  const handleStartCapture = useCallback(
    async (idx: number) => {
      if (!enabled) return;
      setActiveIdx(idx);
      setCapturePhase("raising-z");
      setError(null);
      try {
        // Step 1: raise Z to safe height.
        await jogTo({ z: 0 }, RAPID_JOG_FEED);
        setCapturePhase("navigating-xy");
      } catch (e) {
        setError(String(e));
        setCapturePhase("idle");
        setActiveIdx(null);
      }
    },
    [enabled, jogTo],
  );

  /** Confirm the spindle is over the fiducial and capture its position. */
  const handleCapture = useCallback(async () => {
    if (activeIdx === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.fiducial.capture(activeIdx);
      await refreshState();
      // Return to idle capture phase; keep activeIdx so the user can see the result.
      setCapturePhase("idle");
      setActiveIdx(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [activeIdx, busy, refreshState]);

  /** Cancel the in-progress capture navigation. */
  const handleCancelCapture = useCallback(() => {
    stopContinuous();
    setActiveIdx(null);
    setCapturePhase("idle");
  }, [stopContinuous]);

  /** Run fiducial_solve and refresh state. */
  const handleSolve = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.fiducial.solve();
      await refreshState();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, refreshState]);

  /** Reset all fiducial data. */
  const handleReset = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    stopContinuous();
    setActiveIdx(null);
    setCapturePhase("idle");
    try {
      await api.fiducial.reset();
      // Re-init so the backend has the current ideal positions again.
      await api.fiducial.init(entries);
      await refreshState();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, stopContinuous, entries, refreshState]);

  const fiducials: FiducialDto[] = fiducialState?.fiducials ?? [];
  const capturedCount = fiducialState?.capturedCount ?? 0;
  const hasRegistration = fiducialState?.hasRegistration ?? false;
  const rmsResidualMm = fiducialState?.rmsResidualMm ?? 0;
  const rmsSeverity = hasRegistration ? classifyRms(rmsResidualMm) : null;

  const solveReady = canSolve(capturedCount);

  if (regHoles.length === 0) {
    return (
      <>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 shrink-0">
          <button
            type="button"
            onClick={onBack}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <ChevronLeft className="size-4" />
            {t("fiducial.back")}
          </button>
          <span className="text-sm font-semibold text-foreground">{t("fiducial.title")}</span>
        </div>
        <div className="flex flex-1 items-center justify-center p-4 text-center text-[12px] text-muted-foreground">
          {t("fiducial.noRegistrationHoles")}
        </div>
      </>
    );
  }

  // XY jog pad for the capture mode.
  const padBtn =
    "flex h-[44px] w-full items-center justify-center rounded-lg border border-border bg-muted/45 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground active:translate-y-px disabled:pointer-events-none disabled:opacity-30";

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
    <>
      {/* Mode header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 shrink-0">
        <button
          type="button"
          onClick={() => {
            handleCancelCapture();
            onBack();
          }}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          {t("fiducial.back")}
        </button>
        <span className="text-sm font-semibold text-foreground">{t("fiducial.title")}</span>
        {hasRegistration && (
          <span
            className={
              "ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] " +
              (rmsSeverity === "good"
                ? "bg-emerald-500/15 text-emerald-400"
                : rmsSeverity === "warn"
                  ? "bg-amber-500/15 text-amber-400"
                  : "bg-rose-500/15 text-rose-400")
            }
          >
            <CheckCircle2 className="size-3" />
            {t("fiducial.solved")}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto">
        {/* Error banner */}
        {error && (
          <div className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="shrink-0 text-rose-300/70 hover:text-rose-200"
            >
              ✕
            </button>
          </div>
        )}

        {/* Intro hint */}
        <p className="px-4 pt-3 text-[11px] text-muted-foreground">{t("fiducial.hint")}</p>

        {/* Fiducial list */}
        <div className="flex flex-col gap-2 px-4 pt-3">
          {regHoles.map((hole, idx) => {
            const dto: FiducialDto | undefined = fiducials[idx];
            const captured = dto?.captured ?? false;
            const isActive = activeIdx === idx;

            return (
              <div
                key={hole.id}
                className={
                  "rounded-lg border p-3 transition-colors " +
                  (isActive
                    ? "border-primary/50 bg-primary/5"
                    : captured
                      ? "border-emerald-500/30 bg-emerald-500/5"
                      : "border-border bg-card/40")
                }
              >
                <div className="flex items-center gap-2">
                  {/* Status dot */}
                  <div
                    className={
                      "grid size-8 shrink-0 place-items-center rounded-md " +
                      (captured
                        ? "bg-emerald-500/20 text-emerald-400"
                        : isActive
                          ? "bg-primary/20 text-primary"
                          : "bg-muted text-muted-foreground")
                    }
                  >
                    {captured ? (
                      <CheckCircle2 className="size-4" />
                    ) : isActive ? (
                      <Crosshair className="size-4" />
                    ) : (
                      <Circle className="size-4" />
                    )}
                  </div>

                  {/* Label + coords */}
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-medium text-foreground">
                      {t("fiducial.markerN", { n: idx + 1 })}
                    </div>
                    {entries[idx] && (
                      <div className="text-[11px] text-muted-foreground">
                        {"X "}
                        {fmtLen(entries[idx].ideal.x)}
                        {" · Y "}
                        {fmtLen(entries[idx].ideal.y)}
                      </div>
                    )}
                  </div>

                  {/* Action button */}
                  {!isActive && (
                    <Button
                      size="sm"
                      variant={captured ? "secondary" : "outline"}
                      disabled={!connected || (activeIdx !== null && !isActive)}
                      onClick={() => void handleStartCapture(idx)}
                      className="shrink-0 text-[11px]"
                    >
                      {captured ? t("fiducial.recapture") : t("fiducial.navigate")}
                    </Button>
                  )}
                  {isActive && (
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={handleCancelCapture}
                      className="shrink-0 text-[11px]"
                    >
                      {t("fiducial.cancel")}
                    </Button>
                  )}
                </div>

                {/* Inline jog pad — shown only for the active fiducial */}
                {isActive && capturePhase !== "raising-z" && (
                  <div className="mt-3 flex flex-col gap-2.5 rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
                    {/* Z safety hint */}
                    <p className="text-[11px] text-muted-foreground">
                      {capturePhase === "navigating-xy"
                        ? t("fiducial.jogHintXY")
                        : t("fiducial.jogHintReady")}
                    </p>

                    {/* Step control — only fine steps */}
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
                        {t("fiducial.fineMoveLabel")}
                      </span>
                      <JogStepControl
                        steps={FIDUCIAL_CAPTURE_STEPS_MM}
                        step={step}
                        setStep={setStep}
                        continuous={continuous}
                        onBeforeChange={stopContinuous}
                      />
                    </div>

                    {/* 3×3 XY jog pad */}
                    <div className="grid grid-cols-3 gap-1.5">
                      <button type="button" disabled={!enabled} className={padBtn} {...xyProps(-1, 1)}>
                        <ArrowUpLeft className="size-4" />
                      </button>
                      <button type="button" disabled={!enabled} className={padBtn} {...xyProps(0, 1)}>
                        <ArrowUp className="size-4" />
                      </button>
                      <button type="button" disabled={!enabled} className={padBtn} {...xyProps(1, 1)}>
                        <ArrowUpRight className="size-4" />
                      </button>
                      <button type="button" disabled={!enabled} className={padBtn} {...xyProps(-1, 0)}>
                        <ArrowLeft className="size-4" />
                      </button>
                      {/* Navigate to ideal XY */}
                      <button
                        type="button"
                        disabled={!enabled || !entries[idx]}
                        className={padBtn}
                        title={t("fiducial.jogToIdeal")}
                        onClick={() =>
                          entries[idx] &&
                          void jogTo(
                            { x: entries[idx].ideal.x, y: entries[idx].ideal.y },
                            RAPID_JOG_FEED,
                          )
                        }
                      >
                        <Crosshair className="size-4" />
                      </button>
                      <button type="button" disabled={!enabled} className={padBtn} {...xyProps(1, 0)}>
                        <ArrowRight className="size-4" />
                      </button>
                      <button type="button" disabled={!enabled} className={padBtn} {...xyProps(-1, -1)}>
                        <ArrowDownLeft className="size-4" />
                      </button>
                      <button type="button" disabled={!enabled} className={padBtn} {...xyProps(0, -1)}>
                        <ArrowDown className="size-4" />
                      </button>
                      <button type="button" disabled={!enabled} className={padBtn} {...xyProps(1, -1)}>
                        <ArrowDownRight className="size-4" />
                      </button>
                    </div>

                    {/* Capture button */}
                    <Button
                      size="sm"
                      disabled={!enabled || busy}
                      onClick={() => void handleCapture()}
                      className="w-full"
                    >
                      <CheckCircle2 className="size-4" />
                      {t("fiducial.captureHere")}
                    </Button>
                  </div>
                )}

                {/* Raising-Z hint for the active fiducial */}
                {isActive && capturePhase === "raising-z" && (
                  <p className="mt-2 text-[11px] text-muted-foreground">{t("fiducial.raisingZ")}</p>
                )}
              </div>
            );
          })}
        </div>

        {/* Registration result */}
        {hasRegistration && rmsResidualMm !== undefined && (
          <div
            className={
              "mx-4 mt-3 rounded-lg border px-3 py-2.5 " +
              (rmsSeverity === "good"
                ? "border-emerald-500/30 bg-emerald-500/5"
                : rmsSeverity === "warn"
                  ? "border-amber-500/30 bg-amber-500/5"
                  : "border-rose-500/40 bg-rose-500/10")
            }
          >
            <div className="flex items-center gap-2">
              <CheckCircle2
                className={
                  "size-4 shrink-0 " +
                  (rmsSeverity === "good"
                    ? "text-emerald-400"
                    : rmsSeverity === "warn"
                      ? "text-amber-400"
                      : "text-rose-400")
                }
              />
              <span
                className={
                  "text-[12px] font-medium " +
                  (rmsSeverity === "good"
                    ? "text-emerald-400"
                    : rmsSeverity === "warn"
                      ? "text-amber-400"
                      : "text-rose-400")
                }
              >
                {t("fiducial.rmsLabel")}
                {" "}
                {fmtLen(rmsResidualMm)}
              </span>
            </div>
            {rmsSeverity === "warn" && (
              <p className="mt-1 text-[11px] text-amber-400/80">{t("fiducial.rmsWarnHint")}</p>
            )}
            {rmsSeverity === "bad" && (
              <p className="mt-1 text-[11px] text-rose-400/80">{t("fiducial.rmsBadHint")}</p>
            )}
          </div>
        )}

        <div className="flex-1" />
      </div>

      {/* Sticky footer */}
      <div className="sticky bottom-0 mt-auto flex shrink-0 flex-col gap-2 border-t border-border bg-panel p-3">
        <Button
          size="sm"
          disabled={!solveReady || busy || activeIdx !== null}
          onClick={() => void handleSolve()}
          className="w-full"
        >
          <RefreshCw className="size-4" />
          {t("fiducial.solve", { count: capturedCount })}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void handleReset()}
          className="w-full"
        >
          <RotateCcw className="size-4" />
          {t("fiducial.reset")}
        </Button>
        {!solveReady && (
          <p className="text-center text-[11px] text-muted-foreground">
            {t("fiducial.solveHint", { needed: 2, captured: capturedCount })}
          </p>
        )}
      </div>
    </>
  );
}
