import { useEffect } from "react";
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
  LocateFixed,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { gotoWorkZero, safeRetractMachineZ } from "@/lib/gotoZero";
import { useJog } from "@/hooks/useJog";
import { JogStepControl } from "@/components/machine/JogStepControl";

const jogBtn =
  "group relative grid h-9 place-items-center rounded-lg border border-border bg-background text-muted-foreground transition-all hover:border-primary/50 hover:text-foreground active:scale-[0.96] active:bg-primary/10 active:text-primary disabled:opacity-30 disabled:pointer-events-none";

/** Redesigned jog pad: 3×3 XY grid with diagonals, a centre go-to-work-zero
 *  button, a Z column, a step segmented control (with a continuous "hold" mode)
 *  and a feed input. Keyboard jog (arrows / PgUp / PgDn / 1·2·3) mirrors the
 *  button behaviour, including hold-to-move in continuous mode. */
export function JogPad() {
  const { t } = useTranslation("machine");
  const cnc = useSettings((s) => s.cncProfile);
  const setCnc = useSettings((s) => s.setCncProfile);
  const machineZ = useMachine((s) => s.status.mpos[2]);
  const workZ = useMachine((s) => s.status.wpos[2]);
  const homed = useMachine((s) => s.homed);
  // Shared jog controller (step + step/continuous moves), so the Z-bar Z± buttons
  // stay in sync with the step picked here.
  const { enabled, step, setStep, continuous, go, startContinuous, stopContinuous } = useJog();
  // The centre go-to-work-zero does a machine-frame (G53) safe-Z retract, so it
  // additionally requires a homed frame. Manual jog stays ungated.
  const canAutoMove = enabled && homed;
  // Safe retract: a clearance above the work-zero surface, capped at the machine
  // ceiling. wcoZ = machine Z of work zero (mpos.z − wpos.z).
  const retractZ = safeRetractMachineZ(machineZ - workZ, cnc.safeZMm, cnc.machineSafeZMm);

  // Cancel any in-flight continuous jog on unmount so the machine never keeps
  // running after the controls go away (the hook handles the motion-disallowed
  // case itself).
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
          void startContinuous(dir[0], dir[1], dir[2]);
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
          stopContinuous(); // leaving continuous mode must halt any in-flight move
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
            void startContinuous(dx, dy, dz);
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
            void startContinuous(0, 0, dz);
          },
          onPointerUp: () => stopContinuous(),
          onPointerLeave: () => stopContinuous(),
          onPointerCancel: () => stopContinuous(),
        }
      : { onClick: () => go(0, 0, dz) };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {/* XY 3×3 with diagonals */}
        <div className="grid flex-1 grid-cols-3 gap-1.5">
          {dirBtn(-1, 1, 0, "X− Y+", <ArrowUpLeft className="size-4" />)}
          {dirBtn(0, 1, 0, "Y+ (↑)", <ArrowUp className="size-5" />)}
          {dirBtn(1, 1, 0, "X+ Y+", <ArrowUpRight className="size-4" />)}

          {dirBtn(-1, 0, 0, "X− (←)", <ArrowLeft className="size-5" />)}
          <button
            type="button"
            title={canAutoMove ? t("jog.gotoXY") : t("controls.homeFirst")}
            disabled={!canAutoMove}
            onClick={() => void gotoWorkZero(["x", "y"], retractZ, machineZ, canAutoMove)}
            className="grid h-9 place-items-center rounded-lg border border-primary/40 bg-primary/10 text-primary transition-colors hover:bg-primary/20 disabled:pointer-events-none disabled:opacity-30"
          >
            <LocateFixed className="size-5" />
          </button>
          {dirBtn(1, 0, 0, "X+ (→)", <ArrowRight className="size-5" />)}

          {dirBtn(-1, -1, 0, "X− Y−", <ArrowDownLeft className="size-4" />)}
          {dirBtn(0, -1, 0, "Y− (↓)", <ArrowDown className="size-5" />)}
          {dirBtn(1, -1, 0, "X+ Y−", <ArrowDownRight className="size-4" />)}
        </div>
        {/* Z column */}
        <div className="flex w-[52px] flex-col gap-1.5">
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
        <JogStepControl
          steps={cnc.jogStepsMm}
          step={step}
          setStep={setStep}
          continuous={continuous}
          onBeforeChange={stopContinuous}
        />
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
