import { useCallback, useEffect, useState } from "react";
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
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { gotoWorkZero } from "@/lib/gotoZero";

const jogBtn =
  "group relative grid h-12 place-items-center rounded-lg border border-border bg-background text-muted-foreground transition-all hover:border-primary/50 hover:text-foreground active:scale-[0.96] active:bg-primary/10 active:text-primary disabled:opacity-30 disabled:pointer-events-none";

/** Redesigned jog pad: 3×3 XY grid with diagonals, a centre go-to-work-zero
 *  button, a Z column, a step segmented control and a feed input. Keyboard jog
 *  (arrows / PgUp / PgDn / 1·2·3) mirrors the original JogPad behaviour. */
export function JogPad() {
  const { t } = useTranslation("machine");
  const cnc = useSettings((s) => s.cncProfile);
  const setCnc = useSettings((s) => s.setCncProfile);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const enabled = canMove(state, connected);
  // Active jog step — transient UI choice (not persisted); default to the middle
  // step if present, else the first.
  const [step, setStep] = useState(cnc.jogStepsMm[Math.min(1, cnc.jogStepsMm.length - 1)] ?? 1);

  const go = useCallback(
    (dx: number, dy: number, dz: number) => {
      if (enabled) void api.machine.jog(dx * step, dy * step, dz * step, cnc.jogFeedMmMin);
    },
    [enabled, step, cnc.jogFeedMmMin],
  );

  // Keyboard arrow jog: skip while typing in an input/textarea; `go` is a no-op
  // when motion isn't allowed. `1/2/3` pick the first three jog steps.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
      switch (e.key) {
        case "ArrowUp":
          e.preventDefault();
          go(0, 1, 0);
          break;
        case "ArrowDown":
          e.preventDefault();
          go(0, -1, 0);
          break;
        case "ArrowLeft":
          e.preventDefault();
          go(-1, 0, 0);
          break;
        case "ArrowRight":
          e.preventDefault();
          go(1, 0, 0);
          break;
        case "PageUp":
          e.preventDefault();
          go(0, 0, 1);
          break;
        case "PageDown":
          e.preventDefault();
          go(0, 0, -1);
          break;
        case "1":
        case "2":
        case "3": {
          const i = Number(e.key) - 1;
          const s = cnc.jogStepsMm[i];
          if (s !== undefined) {
            e.preventDefault();
            setStep(s);
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, cnc.jogStepsMm]);

  const dirBtn = (dx: number, dy: number, dz: number, title: string, icon: ReactNode) => (
    <button type="button" title={title} className={jogBtn} disabled={!enabled} onClick={() => go(dx, dy, dz)}>
      {icon}
    </button>
  );

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
            onClick={() => gotoWorkZero(["x", "y"], cnc.safeZMm)}
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
            onClick={() => go(0, 0, 1)}
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
            onClick={() => go(0, 0, -1)}
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
      </div>
    </div>
  );
}
