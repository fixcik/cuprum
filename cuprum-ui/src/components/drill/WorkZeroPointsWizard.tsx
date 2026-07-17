import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Check,
  CheckCircle2,
  ChevronLeft,
  ChevronsUp,
  Circle,
  Crosshair,
} from "lucide-react";
import { api, type FiducialSolveResult, type FiducialStateDto } from "@/lib/api";
import type { DatumCorner } from "@/lib/datum";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { EffectiveAlignmentPoint } from "@/lib/alignmentPoints";
import { isProbeable } from "@/lib/alignmentPoints";
import {
  buildFiducialEntries,
  captureBoundsAroundMachine,
  classifyRms,
  pointResiduals,
  FIDUCIAL_CAPTURE_RADIUS_MM,
  FIDUCIAL_CAPTURE_STEPS_MM,
  FIDUCIAL_Z_DESCENT_FEED_MM_MIN,
  MIN_CAPTURES_FOR_SOLVE,
} from "@/lib/fiducialRegistration";
import type { JogBounds } from "@/lib/jogBounds";
import { useJog, RAPID_JOG_FEED } from "@/hooks/useJog";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { safeRetractMachineZ } from "@/lib/gotoZero";
import { canMove } from "@/lib/machineControls";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { Button } from "@/components/ui/Button";
import { JogStepControl } from "@/components/machine/JogStepControl";
import { DrillManualZBar } from "@/components/drill/DrillManualZBar";
import { DrillTableMap } from "@/components/drill/DrillTableMap";

/** Jog steps offered on the capture screen: the fine capture steps plus two
 *  coarse ones for the fully manual approach to the first point. */
const WIZARD_JOG_STEPS_MM: number[] = [...FIDUCIAL_CAPTURE_STEPS_MM, 1, 10];

/** Distance (mm) at which the readout turns green ("close enough to eyeball"). */
const DIST_GOOD_MM = 0.5;

export interface WorkZeroPointsWizardProps {
  /** Effective alignment points (auto fiducials + user points) of the panel. */
  points: EffectiveAlignmentPoint[];
  datum: DatumCorner;
  panelWidthMm: number;
  panelHeightMm: number;
  /** Machine travel envelope (mm, positive). */
  maxXMm: number;
  maxYMm: number;
  maxZMm: number;
  /** Selected sub-plan — drawn on the table map shown for the first (fully
   *  manual) point so the operator can click-to-move. */
  plan: PanelDrillPlan;
  /** Cancel the wizard: back to the method picker (motion stopped, backend
   *  session reset by the wizard before calling this). */
  onCancel: () => void;
  /** The operator confirmed the solved zero on the result screen. The zero is
   *  ALREADY programmed on the controller at this point (fiducial_solve sets
   *  G54 atomically with the fit) — this callback only records the binding
   *  metadata and returns to the plan. */
  onApplied: (result: { rmsMm: number; angleDeg: number; workOrigin: { x: number; y: number } }) => void;
}

type WizardStep = "select" | "capture" | "result";

/** Auto-approach sub-phase while "Navigate" drives the machine. */
type NavPhase = "idle" | "raising-z" | "navigating-xy";

/** Wizard for work-zero method 2 — manual capture of 2+ panel alignment points.
 *
 *  Step 1: pick 2+ points. Step 2: per point — approach (manual for the first
 *  point, auto "Navigate" once a coarse offset is known), fine-tune, capture
 *  the MPos. Step 3: the solve result (RMS, board rotation, per-point
 *  residuals) with apply/restart.
 *
 *  The solve itself programs G54 on the controller (backend `fiducial_solve`
 *  is atomic: fit + G10 L2), so step 3 shows an ALREADY-BOUND zero; "Apply"
 *  merely confirms it in the UI (binding metadata + back to plan), and
 *  "Start over" resets the capture session — the controller zero stays until
 *  the next solve overwrites it. */
export function WorkZeroPointsWizard({
  points,
  datum,
  panelWidthMm,
  panelHeightMm,
  maxXMm,
  maxYMm,
  maxZMm,
  plan,
  onCancel,
  onApplied,
}: WorkZeroPointsWizardProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();

  const machineState = useMachine((s) => s.status.state);
  const connected = useMachine((s) => s.connected);
  // Machine-frame moves (safe-Z retract, auto-navigate) need a homed machine:
  // when unhomed, mpos is GRBL-relative-to-power-on and meaningless.
  const homed = useMachine((s) => s.homed);
  const enabled = canMove(machineState, connected);
  const cncProfile = useSettings((s) => s.cncProfile);
  const { mpos: liveMpos } = useMachine((s) => s.status);

  const [step, setStep] = useState<WizardStep>("select");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(points.map((p) => p.point.id)),
  );
  // Points of the capture session, frozen at "begin" in list order.
  const [sessionPoints, setSessionPoints] = useState<EffectiveAlignmentPoint[]>([]);
  const [curIdx, setCurIdx] = useState(0);
  const [navPhase, setNavPhase] = useState<NavPhase>("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fidState, setFidState] = useState<FiducialStateDto | null>(null);
  const [solve, setSolve] = useState<FiducialSolveResult | null>(null);
  // Cancels an in-flight auto-navigate sequence (STOP / leave).
  const navCancelRef = useRef(0);

  // Display names: "Fiducial N" for registration-derived points, "Point N" for
  // user-placed ones, numbered independently per source.
  const names = useMemo(() => {
    const m = new Map<string, string>();
    let reg = 0;
    let usr = 0;
    for (const p of points) {
      const n = p.source === "registration" ? ++reg : ++usr;
      m.set(
        p.point.id,
        p.source === "registration"
          ? t("wizard2.pointNameRegistration", { n })
          : t("wizard2.pointNameUser", { n }),
      );
    }
    return m;
  }, [points, t]);

  // Ideal datum-relative entries for the frozen session points.
  const entries = useMemo(
    () =>
      buildFiducialEntries(
        sessionPoints.map((p) => p.point),
        datum,
        panelWidthMm,
        panelHeightMm,
      ),
    [sessionPoints, datum, panelWidthMm, panelHeightMm],
  );

  const machineBounds: JogBounds = useMemo(
    () => ({ x: [0, maxXMm], y: [0, maxYMm], z: [-maxZMm, 0] }),
    [maxXMm, maxYMm, maxZMm],
  );

  // Expected machine-frame target of the current point: ideal + coarse offset.
  // Unknown (null) until the first capture establishes the offset — the first
  // point is approached fully manually.
  const coarseOffset = fidState?.coarseOffset ?? null;
  const curEntry = step === "capture" ? entries[curIdx] : undefined;
  const targetMachine =
    curEntry && coarseOffset
      ? { x: curEntry.ideal.x + coarseOffset.x, y: curEntry.ideal.y + coarseOffset.y }
      : null;

  const distMm = targetMachine
    ? Math.hypot(liveMpos[0] - targetMachine.x, liveMpos[1] - targetMachine.y)
    : null;

  // Fine-capture clamp: once the spindle is inside the ±r capture box around the
  // target, restrict jogs to it (prevents accidental large moves with Z lowered).
  // Outside the box (or with no target yet) the full envelope applies.
  const jogBounds: JogBounds =
    targetMachine && distMm !== null && distMm <= FIDUCIAL_CAPTURE_RADIUS_MM
      ? captureBoundsAroundMachine(targetMachine.x, targetMachine.y, machineBounds)
      : machineBounds;

  const { step: jogStep, setStep: setJogStep, continuous, go, startContinuous, stopContinuous, jogTo } =
    useJog({ bounds: jogBounds });

  const moving = machineState === "jog" || navPhase !== "idle";

  // Stop any in-flight continuous jog on unmount.
  useEffect(() => () => stopContinuous(), [stopContinuous]);

  const refreshState = useCallback(async (): Promise<FiducialStateDto> => {
    const st = await api.fiducial.state();
    setFidState(st);
    return st;
  }, []);

  /** Machine-frame safe retract height for the current work offset. */
  const retractMachineZ = useCallback(() => {
    const { mpos, wpos } = useMachine.getState().status;
    const wcoZ = mpos[2] - wpos[2];
    return {
      machineZ: safeRetractMachineZ(wcoZ, cncProfile.safeZMm, cncProfile.machineSafeZMm),
      wcoZ,
    };
  }, [cncProfile.safeZMm, cncProfile.machineSafeZMm]);

  /** Raise Z to the machine-frame safe retract height (rapid). */
  const raiseToSafeZ = useCallback(async () => {
    if (!enabled || !homed) return;
    const { machineZ, wcoZ } = retractMachineZ();
    await jogTo({ z: machineZ - wcoZ }, RAPID_JOG_FEED);
  }, [enabled, homed, retractMachineZ, jogTo]);

  /** Wait until the machine leaves the jog state (move finished or cancelled). */
  const waitMotionDone = useCallback(async (token: number) => {
    const deadline = Date.now() + 30_000;
    // Give GRBL a beat to enter the jog state before polling it away.
    await new Promise((r) => setTimeout(r, 250));
    while (Date.now() < deadline) {
      if (navCancelRef.current !== token) return false;
      if (useMachine.getState().status.state !== "jog") return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }, []);

  /** Wait until a status report shows machine Z at/above the given height.
   *
   * Deliberately position-based, not state-based: a stale status snapshot
   * still carries the old (lower) Z, so it keeps us waiting — the XY leg can
   * never start while the tool is actually down. A rejected or cancelled
   * retract never satisfies the predicate and fails closed via the timeout. */
  const waitZAtOrAbove = useCallback(async (machineZ: number, token: number) => {
    const deadline = Date.now() + 30_000;
    const tolMm = 0.05;
    while (Date.now() < deadline) {
      if (navCancelRef.current !== token) return false;
      if (useMachine.getState().status.mpos[2] >= machineZ - tolMm) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return false;
  }, []);

  /** Step 1 → 2: freeze the selection, init the backend session, raise Z. */
  const handleBegin = useCallback(async () => {
    const sel = points.filter((p) => selectedIds.has(p.point.id));
    if (sel.length < MIN_CAPTURES_FOR_SOLVE) return;
    setBusy(true);
    setError(null);
    setSolve(null);
    try {
      const newEntries = buildFiducialEntries(
        sel.map((p) => p.point),
        datum,
        panelWidthMm,
        panelHeightMm,
      );
      // init resets any previous measurements + solved transform.
      await api.fiducial.init(newEntries);
      setSessionPoints(sel);
      setCurIdx(0);
      await refreshState();
      setStep("capture");
      // Park Z at the safe height so the manual XY approach can't drag the tool.
      if (homed) void raiseToSafeZ();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [points, selectedIds, datum, panelWidthMm, panelHeightMm, refreshState, homed, raiseToSafeZ]);

  /** Auto-approach the current point: raise Z, drive XY to ideal + offset. */
  const handleNavigate = useCallback(async () => {
    if (!enabled || !homed || !targetMachine) return;
    const token = ++navCancelRef.current;
    setError(null);
    setNavPhase("raising-z");
    try {
      const { machineZ, wcoZ } = retractMachineZ();
      await jogTo({ z: machineZ - wcoZ }, RAPID_JOG_FEED);
      // Gate the XY leg on the REPORTED Z height, not on the jog state: the
      // cached status may still predate the retract, and "not jogging" on a
      // stale snapshot must not launch XY while the tool is down (see
      // waitZAtOrAbove).
      if (!(await waitZAtOrAbove(machineZ, token))) return;
      setNavPhase("navigating-xy");
      const { mpos, wpos } = useMachine.getState().status;
      const wcoX = mpos[0] - wpos[0];
      const wcoY = mpos[1] - wpos[1];
      await jogTo({ x: targetMachine.x - wcoX, y: targetMachine.y - wcoY }, RAPID_JOG_FEED);
      await waitMotionDone(token);
    } catch (e) {
      setError(String(e));
    } finally {
      if (navCancelRef.current === token) setNavPhase("idle");
    }
  }, [enabled, homed, targetMachine, retractMachineZ, jogTo, waitMotionDone, waitZAtOrAbove]);

  /** STOP: cancel any in-flight motion (jog or auto-navigate). */
  const handleStop = useCallback(() => {
    navCancelRef.current++;
    setNavPhase("idle");
    stopContinuous();
    void api.machine.jogCancel();
  }, [stopContinuous]);

  /** Capture the current point; advance / auto-solve when all are captured. */
  const handleCapture = useCallback(async () => {
    if (busy || moving) return;
    setBusy(true);
    setError(null);
    try {
      await api.fiducial.capture(curIdx);
      const st = await refreshState();
      const next = st.fiducials.findIndex((f) => !f.captured);
      if (next === -1) {
        // All captured — solve programs the G54 origin on the controller and
        // returns the residual registration; the result screen shows a zero
        // that is already bound.
        const res = await api.fiducial.solve();
        setSolve(res);
        await refreshState();
        setStep("result");
      } else {
        setCurIdx(next);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [busy, moving, curIdx, refreshState]);

  /** Leave the wizard: stop motion, drop the backend capture session. */
  const handleBack = useCallback(() => {
    handleStop();
    // A zero already programmed by a previous solve stays on the controller;
    // reset only clears the capture session + residual registration.
    void api.fiducial.reset();
    onCancel();
  }, [handleStop, onCancel]);

  /** Step 3 → 1: reset the session and pick points again. The controller zero
   *  remains bound until the next solve overwrites it. */
  const handleRestart = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await api.fiducial.reset();
      setFidState(null);
      setSolve(null);
      setSessionPoints([]);
      setCurIdx(0);
      setStep("select");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  /** Recapture point `i` (from step 2 list or the result screen). */
  const handleRecapture = useCallback((i: number) => {
    setCurIdx(i);
    setStep("capture");
  }, []);

  // ── Presentation helpers ──────────────────────────────────────────────────

  const padBtn =
    "flex h-[42px] w-full items-center justify-center rounded-lg border border-border bg-muted/45 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground active:translate-y-px disabled:pointer-events-none disabled:opacity-30";

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

  const crumb = (n: number, label: string, state: "active" | "done" | "future") => (
    <span
      className={
        "flex items-center gap-1.5 rounded-[7px] px-2.5 py-1 text-[11.5px] font-semibold " +
        (state === "active"
          ? "bg-primary/[0.16] text-primary"
          : state === "done"
            ? "bg-success/[0.12] text-success"
            : "bg-muted text-muted-foreground")
      }
    >
      <span className="tabular-nums">{state === "done" ? <Check className="size-3" /> : n}</span>
      {label}
    </span>
  );

  const stepOrder: WizardStep[] = ["select", "capture", "result"];
  const stepIdx = stepOrder.indexOf(step);
  const crumbState = (i: number): "active" | "done" | "future" =>
    i === stepIdx ? "active" : i < stepIdx ? "done" : "future";

  const selectedCount = selectedIds.size;
  const fiducials = fidState?.fiducials ?? [];
  const capturedCount = fidState?.capturedCount ?? 0;

  // Result-screen data.
  const rmsMm = solve?.registration.rmsResidualMm ?? null;
  const rmsSeverity = rmsMm != null ? classifyRms(rmsMm) : null;
  const angleDeg = solve ? (solve.registration.angleRad * 180) / Math.PI : null;
  const residuals = useMemo(
    () => (solve ? pointResiduals(fiducials, solve.registration, solve.workOrigin) : []),
    [solve, fiducials],
  );

  const sevText = (s: "good" | "warn" | "bad") =>
    s === "good" ? "text-success" : s === "warn" ? "text-warning" : "text-destructive";
  const sevChip = (s: "good" | "warn" | "bad") =>
    s === "good"
      ? "bg-success/[0.14] text-success"
      : s === "warn"
        ? "bg-warning/[0.14] text-warning"
        : "bg-destructive/[0.14] text-destructive";
  const sevBorder = (s: "good" | "warn" | "bad") =>
    s === "good" ? "border-success/40" : s === "warn" ? "border-warning/40" : "border-destructive/50";

  // Capture CTA gate: motion always blocks; the 3 mm distance gate applies only
  // when a target is known (points 2+) — the first capture is free-form.
  const captureTooFar =
    targetMachine !== null && distMm !== null && distMm > FIDUCIAL_CAPTURE_RADIUS_MM;
  const captureDisabled = !enabled || busy || moving || captureTooFar;

  const badge = (cls: string, label: string) => (
    <span className={"rounded-[5px] px-1.5 py-0.5 text-[10px] font-semibold " + cls}>{label}</span>
  );

  return (
    <>
      {/* Mode header: back to methods + title */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 shrink-0">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          {t("zeroMethod.backMethods")}
        </button>
        <span className="text-sm font-semibold text-foreground">{t("zeroMethod.methodTitle.2")}</span>
      </div>

      {/* Step crumbs */}
      <div className="flex gap-1.5 border-b border-border px-3 py-2 shrink-0">
        {crumb(1, t("wizard2.stepPoints"), crumbState(0))}
        {crumb(2, t("wizard2.stepCapture"), crumbState(1))}
        {crumb(3, t("wizard2.stepResult"), crumbState(2))}
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto">
        {/* Error banner */}
        {error && (
          <div className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="shrink-0 opacity-70 hover:opacity-100"
            >
              ✕
            </button>
          </div>
        )}

        {/* Not-homed banner: machine-frame moves are undefined until $H. */}
        {connected && !homed && (
          <div className="mx-3 mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className="flex-1">{t("wizard2.notHomed")}</span>
          </div>
        )}

        {/* ── Step 1 · pick points ── */}
        {step === "select" && (
          <div className="flex flex-col gap-2.5 px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                {t("wizard2.selectTitle")}
              </span>
              <button
                type="button"
                onClick={() =>
                  setSelectedIds(
                    selectedCount === points.length
                      ? new Set()
                      : new Set(points.map((p) => p.point.id)),
                  )
                }
                className="text-[12px] font-semibold text-primary hover:underline underline-offset-2"
              >
                {selectedCount === points.length ? t("wizard2.deselectAll") : t("wizard2.selectAll")}
              </button>
            </div>

            {points.map((p) => {
              const checked = selectedIds.has(p.point.id);
              return (
                <button
                  key={p.point.id}
                  type="button"
                  onClick={() =>
                    setSelectedIds((prev) => {
                      const next = new Set(prev);
                      if (checked) next.delete(p.point.id);
                      else next.add(p.point.id);
                      return next;
                    })
                  }
                  className={
                    "flex w-full items-center gap-2.5 rounded-[10px] border bg-card px-3 py-2.5 text-left transition-colors " +
                    (checked ? "border-primary/55" : "border-border hover:border-border/80")
                  }
                >
                  <span
                    className={
                      "grid size-[18px] shrink-0 place-items-center rounded-[5px] border-[1.5px] " +
                      (checked
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground/50 bg-transparent")
                    }
                  >
                    {checked && <Check className="size-3" strokeWidth={3.5} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="text-[13px] font-semibold text-foreground">
                      {names.get(p.point.id)}
                    </span>
                    <span className="ml-2 text-[11.5px] tabular-nums text-muted-foreground">
                      {"X "}
                      {fmtLen(p.point.x_mm)}
                      {" · Y "}
                      {fmtLen(p.point.y_mm)}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    {p.source === "registration"
                      ? badge("bg-primary/15 text-primary", t("wizard2.badgeRegistration"))
                      : badge("bg-muted text-muted-foreground", t("wizard2.badgeUser"))}
                    {isProbeable(p.point) &&
                      badge("bg-success/[0.13] text-success", t("wizard2.badgeProbeable"))}
                  </span>
                </button>
              );
            })}

            <p className="text-[11.5px] leading-relaxed text-muted-foreground/80">
              {t("wizard2.spreadHint")}
            </p>
          </div>
        )}

        {/* ── Step 2 · capture ── */}
        {step === "capture" && curEntry && (
          <div className="flex flex-col gap-3 px-4 py-3">
            {/* Current-point card */}
            <div className="rounded-xl border border-primary/50 bg-primary/[0.07] px-3.5 py-3">
              <div className="flex items-center gap-2">
                <span className="text-[13.5px] font-semibold text-foreground">
                  {t("wizard2.curTitle", {
                    i: curIdx + 1,
                    name: names.get(sessionPoints[curIdx]?.point.id ?? "") ?? "",
                  })}
                </span>
                <span className="ml-auto text-[11.5px] tabular-nums text-muted-foreground">
                  {curIdx + 1}
                  {" / "}
                  {sessionPoints.length}
                </span>
              </div>
              <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">
                {targetMachine ? t("wizard2.hintNext") : t("wizard2.hintFirst")}
              </p>
              {targetMachine && distMm !== null && (
                <div className="mt-2.5 flex items-center gap-2">
                  <span className="text-[11.5px] text-muted-foreground">{t("wizard2.distLabel")}</span>
                  <span
                    className={
                      "text-[15px] font-semibold tabular-nums " +
                      (distMm <= DIST_GOOD_MM
                        ? "text-success"
                        : distMm <= FIDUCIAL_CAPTURE_RADIUS_MM
                          ? "text-warning"
                          : "text-muted-foreground")
                    }
                  >
                    {fmtLen(distMm)}
                  </span>
                  <button
                    type="button"
                    disabled={!enabled || !homed || moving}
                    onClick={() => void handleNavigate()}
                    className="ml-auto flex items-center gap-1.5 rounded-lg border border-primary/60 bg-primary/[0.15] px-3 py-1.5 text-[12px] font-semibold text-primary transition-colors hover:bg-primary/25 disabled:pointer-events-none disabled:opacity-40"
                  >
                    <Crosshair className="size-3.5" />
                    {t("wizard2.navigate")}
                  </button>
                </div>
              )}
              {navPhase !== "idle" && (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {navPhase === "raising-z" ? t("wizard2.raisingZ") : t("wizard2.navigatingXY")}
                </p>
              )}
            </div>

            {/* Table map — click-to-move for the fully manual first approach */}
            {!targetMachine && (
              <DrillTableMap
                plan={plan}
                datum={datum}
                panelWidthMm={panelWidthMm}
                panelHeightMm={panelHeightMm}
                maxXMm={maxXMm}
                maxYMm={maxYMm}
                maxZMm={maxZMm}
              />
            )}

            {/* Step selector + XY jog pad */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                  {t("wizard2.jogLabel")}
                </span>
                <JogStepControl
                  steps={WIZARD_JOG_STEPS_MM}
                  step={jogStep}
                  setStep={setJogStep}
                  continuous={continuous}
                  onBeforeChange={stopContinuous}
                />
              </div>
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
                <span className="grid h-[42px] w-full place-items-center rounded-lg border border-border/60 bg-card/40 text-muted-foreground/50">
                  <Crosshair className="size-4" />
                </span>
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
            </div>

            {/* Z block — safe-descent bar + safe-Z retract (shared component) */}
            <DrillManualZBar
              safeDescent
              safeSteps={FIDUCIAL_CAPTURE_STEPS_MM}
              descentFeedMmMin={FIDUCIAL_Z_DESCENT_FEED_MM_MIN}
              zLabel={t("wizard2.zLabel")}
              caption={t("wizard2.zHint")}
            />
            <button
              type="button"
              disabled={!enabled || !homed}
              className={padBtn}
              title={t("wizard2.raiseZTitle")}
              onClick={() => void raiseToSafeZ()}
            >
              <ChevronsUp className="size-4" />
              <span className="ml-1 text-[11px]">{t("wizard2.raiseZ")}</span>
            </button>

            {/* Session point list with statuses */}
            <div className="flex flex-col gap-1.5">
              {sessionPoints.map((p, i) => {
                const captured = fiducials[i]?.captured ?? false;
                const isCur = i === curIdx;
                // Rough per-point deviation vs the coarse offset — meaningful
                // only once 2+ captures average out the board offset.
                const f = fiducials[i];
                const dev =
                  captured && f?.measured && coarseOffset && capturedCount >= 2
                    ? Math.hypot(
                        f.measured.x - (f.ideal.x + coarseOffset.x),
                        f.measured.y - (f.ideal.y + coarseOffset.y),
                      )
                    : null;
                return (
                  <div
                    key={p.point.id}
                    className={
                      "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] " +
                      (isCur ? "bg-primary/[0.07]" : "bg-card/60")
                    }
                  >
                    {captured ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                    ) : isCur ? (
                      <Crosshair className="size-3.5 shrink-0 text-primary" />
                    ) : (
                      <Circle className="size-3.5 shrink-0 text-muted-foreground/60" />
                    )}
                    <span className="font-semibold text-foreground">{names.get(p.point.id)}</span>
                    <span
                      className={
                        "ml-auto text-[11px] tabular-nums " +
                        (captured ? "text-success" : isCur ? "text-primary" : "text-muted-foreground")
                      }
                    >
                      {captured
                        ? dev != null
                          ? t("wizard2.deviation", { mm: dev.toFixed(2) })
                          : t("wizard2.statusCaptured")
                        : isCur
                          ? t("wizard2.statusCurrent")
                          : t("wizard2.statusWaiting")}
                    </span>
                    {captured && !isCur && (
                      <button
                        type="button"
                        onClick={() => handleRecapture(i)}
                        className="shrink-0 text-[11px] font-semibold text-primary hover:underline underline-offset-2"
                      >
                        {t("wizard2.recapture")}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Step 3 · result ── */}
        {step === "result" && solve && rmsMm != null && rmsSeverity && (
          <div className="flex flex-col gap-3 px-4 py-3">
            {/* Hero RMS card */}
            <div
              className={
                "rounded-xl border bg-card px-4 py-4 text-center " + sevBorder(rmsSeverity)
              }
            >
              <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                {t("wizard2.rmsTitle")}
              </div>
              <div className={"mt-1 text-[34px] font-bold tabular-nums " + sevText(rmsSeverity)}>
                {rmsMm.toFixed(2)}
                <span className="ml-1 text-[15px] font-medium">{t("common:unit.mm")}</span>
              </div>
              <span
                className={
                  "mt-1.5 inline-block rounded-[7px] px-2.5 py-0.5 text-[11.5px] font-semibold " +
                  sevChip(rmsSeverity)
                }
              >
                {rmsSeverity === "good"
                  ? t("wizard2.qualityGood")
                  : rmsSeverity === "warn"
                    ? t("wizard2.qualityWarn")
                    : t("wizard2.qualityBad")}
              </span>
              {angleDeg != null && (
                <p className="mt-2.5 text-[12px] text-muted-foreground">
                  {t("wizard2.rotationNote", { deg: angleDeg.toFixed(2) })}
                </p>
              )}
            </div>

            {/* Per-point residuals */}
            <div className="flex flex-col gap-1.5">
              {sessionPoints.map((p, i) => (
                <div
                  key={p.point.id}
                  className="flex items-center gap-2 rounded-lg bg-card/60 px-2.5 py-2 text-[12px]"
                >
                  <CheckCircle2 className="size-3.5 shrink-0 text-success" />
                  <span className="font-semibold text-foreground">{names.get(p.point.id)}</span>
                  <span className="ml-auto text-[11.5px] tabular-nums text-muted-foreground">
                    {residuals[i] != null
                      ? t("wizard2.deviation", { mm: (residuals[i] as number).toFixed(2) })
                      : "—"}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleRecapture(i)}
                    className="shrink-0 text-[11px] font-semibold text-primary hover:underline underline-offset-2"
                  >
                    {t("wizard2.recapture")}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex-1" />
      </div>

      {/* Sticky footer */}
      <div className="sticky bottom-0 mt-auto flex shrink-0 flex-col gap-2 border-t border-border bg-panel p-3">
        {step === "select" && (
          <>
            <Button
              size="sm"
              disabled={selectedCount < MIN_CAPTURES_FOR_SOLVE || busy}
              onClick={() => void handleBegin()}
              className="w-full"
            >
              {t("wizard2.begin", { count: selectedCount })}
            </Button>
            {selectedCount < MIN_CAPTURES_FOR_SOLVE && (
              <p className="text-center text-[11px] text-muted-foreground">
                {t("wizard2.beginNeed")}
              </p>
            )}
          </>
        )}

        {step === "capture" && (
          <>
            {moving && (
              <button
                type="button"
                onClick={handleStop}
                className="w-full rounded-[10px] border-2 border-destructive bg-destructive/[0.12] px-3 py-2.5 text-[14px] font-bold tracking-[0.05em] text-destructive transition-colors hover:bg-destructive/20"
              >
                {t("wizard2.stop")}
              </button>
            )}
            <Button
              size="sm"
              disabled={captureDisabled}
              onClick={() => void handleCapture()}
              className="w-full"
            >
              <CheckCircle2 className="size-4" />
              {t("wizard2.capture")}
            </Button>
            {captureTooFar && !moving && (
              <p className="text-center text-[11px] text-muted-foreground">
                {t("wizard2.captureTooFar", { mm: FIDUCIAL_CAPTURE_RADIUS_MM })}
              </p>
            )}
          </>
        )}

        {step === "result" && (
          <>
            <Button
              size="sm"
              onClick={() => {
                if (rmsMm == null || solve == null) return;
                onApplied({
                  rmsMm,
                  angleDeg: angleDeg ?? 0,
                  workOrigin: solve.workOrigin,
                });
              }}
              disabled={rmsMm == null || solve == null}
              className="w-full"
            >
              {t("wizard2.apply")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => void handleRestart()}
              className="w-full"
            >
              {t("wizard2.restart")}
            </Button>
          </>
        )}
      </div>
    </>
  );
}
