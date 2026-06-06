import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronUp,
  Infinity as InfinityIcon,
  LocateFixed,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { gotoWorkZero } from "@/lib/gotoZero";

const jogBtn =
  "group relative grid h-12 place-items-center rounded-lg border border-border bg-background text-muted-foreground transition-all hover:border-primary/50 hover:text-foreground active:scale-[0.96] active:bg-primary/10 active:text-primary disabled:opacity-30 disabled:pointer-events-none";

/** Below this many mm of room to the envelope edge a continuous jog is a no-op
 *  (already parked at the edge). */
const MIN_CONT_MM = 0.01;

type Step = number | "cont";

/** Redesigned jog pad: 3×3 XY grid with diagonals, a centre go-to-work-zero
 *  button, a Z column, a step segmented control (with a continuous "hold" mode)
 *  and a feed input. Keyboard jog (arrows / PgUp / PgDn / 1·2·3) mirrors the
 *  button behaviour, including hold-to-move in continuous mode. */
export function JogPad() {
  const { t } = useTranslation("machine");
  const cnc = useSettings((s) => s.cncProfile);
  const setCnc = useSettings((s) => s.setCncProfile);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const workZ = useMachine((s) => s.status.wpos[2]);
  const enabled = canMove(state, connected);
  // Active jog step — transient UI choice (not persisted); default to the middle
  // step if present, else the first.
  const [step, setStep] = useState<Step>(
    cnc.jogStepsMm[Math.min(1, cnc.jogStepsMm.length - 1)] ?? 1,
  );
  const continuous = step === "cont";

  // Whether a continuous jog is currently in flight. Guards against starting a
  // second move (multiple pointers / key + pointer) and makes stop idempotent.
  const movingRef = useRef(false);

  // Step jog: one relative move per click/keypress.
  const go = useCallback(
    (dx: number, dy: number, dz: number) => {
      if (enabled && typeof step === "number")
        void api.machine.jog(dx * step, dy * step, dz * step, cnc.jogFeedMmMin);
    },
    [enabled, step, cnc.jogFeedMmMin],
  );

  // Continuous jog: send a single jog toward the envelope edge along the chosen
  // direction; the trailing jog-cancel on release stops it early. Distance to the
  // edge is measured from the live machine position (`mpos`) against the work
  // envelope (X∈[0,x], Y∈[0,y], Z∈[-z,0]). For diagonals we clamp every active
  // axis to the smallest available room so motion stays on a true 45° line and
  // never leaves the envelope.
  const startContinuous = useCallback(
    (sx: number, sy: number, sz: number) => {
      if (!enabled) return;
      if (movingRef.current) {
        // Another direction is already in flight (e.g. a second key/pointer):
        // cancel it first so directions don't stack inside GRBL's planner.
        void api.machine.jogCancel();
      }
      const mpos = useMachine.getState().status.mpos;
      const env = cnc.workEnvelopeMm;
      // Room available toward the edge for each requested axis (always ≥ 0).
      const roomX = sx > 0 ? env.x - mpos[0] : sx < 0 ? mpos[0] : Infinity;
      const roomY = sy > 0 ? env.y - mpos[1] : sy < 0 ? mpos[1] : Infinity;
      const roomZ = sz > 0 ? 0 - mpos[2] : sz < 0 ? mpos[2] - -env.z : Infinity;
      // Smallest room among the active axes → keeps diagonals straight.
      const room = Math.min(
        sx !== 0 ? Math.max(0, roomX) : Infinity,
        sy !== 0 ? Math.max(0, roomY) : Infinity,
        sz !== 0 ? Math.max(0, roomZ) : Infinity,
      );
      if (!Number.isFinite(room) || room <= MIN_CONT_MM) return;
      movingRef.current = true;
      void api.machine.jog(sx * room, sy * room, sz * room, cnc.jogFeedMmMin);
    },
    [enabled, cnc.workEnvelopeMm, cnc.jogFeedMmMin],
  );

  const stopContinuous = useCallback(() => {
    if (!movingRef.current) return;
    movingRef.current = false;
    void api.machine.jogCancel();
  }, []);

  // Cancel any in-flight continuous jog if motion becomes disallowed
  // (disconnect, alarm, …) or the component unmounts, so the machine never
  // keeps running after the controls go dead.
  useEffect(() => {
    if (!enabled && movingRef.current) stopContinuous();
  }, [enabled, stopContinuous]);
  useEffect(() => () => stopContinuous(), [stopContinuous]);

  // Keyboard jog: skip while typing in an input/textarea/select. In step mode a
  // keydown emits one move (auto-repeat keeps stepping). In continuous mode the
  // first keydown starts the move and keyup stops it — auto-repeat (`e.repeat`)
  // is ignored so the hold is a single jog, not a stream of re-starts.
  useEffect(() => {
    const isTyping = (el: HTMLElement | null) =>
      !!el &&
      (el.tagName === "INPUT" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "SELECT" ||
        el.isContentEditable);

    // Map a key to its jog direction (XY via arrows, Z via PgUp/PgDn).
    const dirOf = (key: string): [number, number, number] | null => {
      switch (key) {
        case "ArrowUp":
          return [0, 1, 0];
        case "ArrowDown":
          return [0, -1, 0];
        case "ArrowLeft":
          return [-1, 0, 0];
        case "ArrowRight":
          return [1, 0, 0];
        case "PageUp":
          return [0, 0, 1];
        case "PageDown":
          return [0, 0, -1];
        default:
          return null;
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target as HTMLElement | null)) return;
      const dir = dirOf(e.key);
      if (dir) {
        e.preventDefault();
        if (continuous) {
          // Ignore the OS key-repeat: hold = one continuous move.
          if (e.repeat) return;
          startContinuous(dir[0], dir[1], dir[2]);
        } else {
          go(dir[0], dir[1], dir[2]);
        }
        return;
      }
      // 1·2·3 pick the first three jog steps (step mode only — continuous has no
      // numeric step). Allow switching back out of continuous via the digits too.
      if (e.key === "1" || e.key === "2" || e.key === "3") {
        const s = cnc.jogStepsMm[Number(e.key) - 1];
        if (s !== undefined) {
          e.preventDefault();
          setStep(s);
        }
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!continuous) return;
      if (dirOf(e.key)) {
        e.preventDefault();
        stopContinuous();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [go, startContinuous, stopContinuous, continuous, cnc.jogStepsMm]);

  // A direction button: click in step mode, press-and-hold in continuous mode.
  const dirBtn = (dx: number, dy: number, dz: number, title: string, icon: ReactNode) => {
    const contProps = continuous
      ? {
          onPointerDown: (e: React.PointerEvent) => {
            e.preventDefault();
            startContinuous(dx, dy, dz);
          },
          onPointerUp: () => stopContinuous(),
          onPointerLeave: () => stopContinuous(),
          onPointerCancel: () => stopContinuous(),
        }
      : { onClick: () => go(dx, dy, dz) };
    return (
      <button type="button" title={title} className={jogBtn} disabled={!enabled} {...contProps}>
        {icon}
      </button>
    );
  };

  // The Z± buttons share the same step/continuous behaviour as dirBtn but with a
  // custom (stacked label) body, so build their handlers here.
  const zProps = (dz: number) =>
    continuous
      ? {
          onPointerDown: (e: React.PointerEvent) => {
            e.preventDefault();
            startContinuous(0, 0, dz);
          },
          onPointerUp: () => stopContinuous(),
          onPointerLeave: () => stopContinuous(),
          onPointerCancel: () => stopContinuous(),
        }
      : { onClick: () => go(0, 0, dz) };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-3">
        {/* XY 3×3 with diagonals */}
        <div className="grid flex-1 grid-cols-3 gap-1.5">
          {dirBtn(-1, 1, 0, "X− Y+", <ArrowUpLeft className="size-4" />)}
          {dirBtn(0, 1, 0, "Y+ (↑)", <ArrowUp className="size-5" />)}
          {dirBtn(1, 1, 0, "X+ Y+", <ArrowUpRight className="size-4" />)}

          {dirBtn(-1, 0, 0, "X− (←)", <ArrowLeft className="size-5" />)}
          <button
            type="button"
            title={t("jog.gotoXY")}
            disabled={!enabled}
            onClick={() => void gotoWorkZero(["x", "y"], cnc.safeZMm, workZ)}
            className="grid h-12 place-items-center rounded-lg border border-primary/40 bg-primary/10 text-primary transition-colors hover:bg-primary/20 disabled:pointer-events-none disabled:opacity-30"
          >
            <LocateFixed className="size-5" />
          </button>
          {dirBtn(1, 0, 0, "X+ (→)", <ArrowRight className="size-5" />)}

          {dirBtn(-1, -1, 0, "X− Y−", <ArrowDownLeft className="size-4" />)}
          {dirBtn(0, -1, 0, "Y− (↓)", <ArrowDown className="size-5" />)}
          {dirBtn(1, -1, 0, "X+ Y−", <ArrowDownRight className="size-4" />)}
        </div>
        {/* Z column */}
        <div className="flex w-[68px] flex-col gap-1.5">
          <button
            type="button"
            title="Z+ (PgUp)"
            className={`${jogBtn} flex-1`}
            disabled={!enabled}
            {...zProps(1)}
          >
            <div className="flex flex-col items-center gap-0.5">
              <ChevronUp className="size-5" />
              <span className="text-[10px] font-semibold">Z+</span>
            </div>
          </button>
          <div className="grid place-items-center text-[9px] uppercase tracking-wide text-muted-foreground/50">
            Z
          </div>
          <button
            type="button"
            title="Z− (PgDn)"
            className={`${jogBtn} flex-1`}
            disabled={!enabled}
            {...zProps(-1)}
          >
            <div className="flex flex-col items-center gap-0.5">
              <span className="text-[10px] font-semibold">Z−</span>
              <ChevronDown className="size-5" />
            </div>
          </button>
        </div>
      </div>

      {/* step + feed */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{t("jog.stepMm")}</span>
          <div className="inline-flex overflow-hidden rounded-md border border-border">
            {cnc.jogStepsMm.map((s) => {
              const on = step === s;
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStep(s)}
                  className={`px-2.5 py-1 text-[12px] tabular-nums transition-colors ${
                    on
                      ? "bg-primary font-semibold text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {s}
                </button>
              );
            })}
            <button
              type="button"
              title={t("jog.continuousHint")}
              onClick={() => setStep("cont")}
              className={`grid place-items-center px-2.5 py-1 text-[12px] transition-colors ${
                continuous
                  ? "bg-primary font-semibold text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <InfinityIcon className="size-3.5" />
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">{t("jog.feed")}</span>
          <div className="relative">
            <input
              type="number"
              value={cnc.jogFeedMmMin}
              onChange={(e) => setCnc({ jogFeedMmMin: Math.max(1, Number(e.target.value) || 1) })}
              className="h-8 w-24 rounded-md border border-border bg-background px-2 pr-9 text-right font-mono text-[12px] tabular-nums outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[9px] text-muted-foreground/60">
              {t("jog.feedUnit")}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground/70">
        <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono">←↑↓→</span>
        <span>XY</span>
        <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono">PgUp/PgDn</span>
        <span>Z</span>
        <span className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono">1·2·3</span>
        <span>{t("jog.step")}</span>
        {continuous && <span>· {t("jog.continuousHint")}</span>}
      </div>
    </div>
  );
}
