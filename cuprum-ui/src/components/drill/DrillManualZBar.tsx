import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { useJog } from "@/hooks/useJog";
import { cn } from "@/lib/utils";

const clamp01 = (f: number) => (f <= 0 ? 0 : f >= 1 ? 1 : f);

/** Z± button — a compact square at each end of the strip (matches the jog-pad style). */
const Z_BTN =
  "grid h-9 w-12 shrink-0 place-items-center rounded-md border border-border bg-card text-foreground transition-colors hover:border-primary/40 hover:bg-foreground/5 active:bg-primary/10 disabled:pointer-events-none disabled:opacity-30";

/** Manual Z touch-off bar for the tool-change card: a Z badge + live readout, a step
 *  selector, and a horizontal track `Z−` | bar | `Z+`. The track maps the MACHINE Z
 *  over the travel `[-maxZMm, 0]` (left = lowest / into the material, right = the homed
 *  ceiling); the blue thumb tracks the live position. Clicking the track jogs Z to that
 *  height (cancel-then-retarget, like the work-zero strip); the Z± buttons step- or
 *  hold-jog by the shared step. A yellow tick marks the previous manual touch-off Z
 *  (`lastZMm`) so the operator can repeat the height for a same-diameter bit.
 *
 *  It does NOT bind Z — the card's confirm button does that (G10 L20 P1 on Z). */
export function DrillManualZBar({ lastZMm }: { lastZMm: number | null }) {
  const { t } = useTranslation("drill");

  const maxZMm = useSettings((s) => s.cncProfile.workEnvelopeMm.z);
  const steps = useSettings((s) => s.cncProfile.jogStepsMm);

  // Live machine/work Z — the work offset converts a track target to a work-frame jog.
  const mz = useMachine((s) => s.status.mpos[2]);
  const wz = useMachine((s) => s.status.wpos[2]);
  const wcoZ = mz - wz;

  // Z-only clamp; X/Y are never jogged from here so their bounds are inert.
  const bounds = {
    x: [0, 0] as [number, number],
    y: [0, 0] as [number, number],
    z: [-maxZMm, 0] as [number, number],
  };
  const { enabled, step, setStep, continuous, go, startContinuous, stopContinuous, jogTo } =
    useJog({ bounds });

  // Stop any in-flight continuous jog on unmount.
  useEffect(() => () => stopContinuous(), [stopContinuous]);

  const trackRef = useRef<HTMLDivElement>(null);
  const range = maxZMm || 1;
  // Thumb / mark fraction: 0 at the bottom (left, -maxZMm) → 1 at the ceiling (right, 0).
  const fracOf = (machineZ: number) => clamp01((machineZ + maxZMm) / range);
  const thumbFrac = fracOf(mz);
  const lastFrac = lastZMm != null ? fracOf(lastZMm) : null;

  // Hover target (fraction along the track) for the tooltip + ghost line.
  const [hoverFrac, setHoverFrac] = useState<number | null>(null);

  // Machine Z under the cursor on the track (left edge = -maxZMm, right edge = 0).
  const machineZAtFrac = (f: number) => -maxZMm + f * maxZMm;
  const fracAt = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return thumbFrac;
    const r = el.getBoundingClientRect();
    return clamp01((clientX - r.left) / r.width);
  };

  const onTrackClick = (e: React.MouseEvent) => {
    if (!enabled) return;
    // jogTo takes WORK coordinates; convert from the machine Z the track maps.
    void jogTo({ z: machineZAtFrac(fracAt(e.clientX)) - wcoZ });
  };

  // Z± buttons: step jog (click) or continuous (hold) — shares the active step via useJog.
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
    <div className="rounded-lg border border-border bg-card/40 p-2.5">
      {/* Z badge + live readout */}
      <div className="flex items-center gap-2">
        <span
          className="grid size-7 place-items-center rounded-md text-[12px] font-bold text-background"
          style={{ background: "hsl(var(--axis-z))" }}
        >
          Z
        </span>
        <span className="text-[12px] font-medium text-foreground">{t("toolChange.zTouchLabel")}</span>
        <span className="ml-auto tabular-nums text-[20px] font-bold leading-none text-foreground">
          {mz.toFixed(1)}
        </span>
        <span className="text-[11px] text-muted-foreground">{t("common:unit.mm")}</span>
      </div>

      {/* Step selector */}
      <div className="mt-2 flex items-center gap-1">
        <span className="mr-0.5 text-[10px] text-muted-foreground">{t("toolChange.stepMm")}</span>
        {steps.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStep(s)}
            className={cn(
              "rounded-md px-2 py-1 text-[11px] tabular-nums transition-colors",
              step === s
                ? "bg-primary text-primary-foreground"
                : "bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Z− | track | Z+ */}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" title="Z−" disabled={!enabled} className={Z_BTN} {...zProps(-1)}>
          <ChevronDown className="size-4" />
        </button>

        <div
          ref={trackRef}
          onClick={onTrackClick}
          onMouseMove={(e) => setHoverFrac(fracAt(e.clientX))}
          onMouseLeave={() => setHoverFrac(null)}
          className={cn(
            "relative h-9 flex-1 overflow-visible rounded-md border border-border",
            enabled && "cursor-pointer",
          )}
          style={{ background: "#0c0e11" }}
        >
          {/* Scale ticks */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-between px-2 opacity-60">
            {Array.from({ length: 15 }, (_, i) => (
              <span key={i} className="h-3 w-px bg-border" />
            ))}
          </div>

          {/* Previous manual-Z mark (vertical line + diamond cap) */}
          {lastFrac != null && (
            <>
              <div
                className="pointer-events-none absolute bottom-0 top-0 w-px"
                style={{ left: `${lastFrac * 100}%`, background: "#e8c14a" }}
              />
              <div
                className="pointer-events-none absolute -top-1 size-1.5 -translate-x-1/2 rotate-45"
                style={{ left: `${lastFrac * 100}%`, background: "#e8c14a" }}
              />
            </>
          )}

          {/* Hover ghost line + target tooltip */}
          {hoverFrac != null && (
            <>
              <div
                className="pointer-events-none absolute bottom-0 top-0 w-px"
                style={{ left: `${hoverFrac * 100}%`, background: "hsl(var(--axis-z) / 0.55)" }}
              />
              <div
                className="pointer-events-none absolute top-full z-20 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] tabular-nums text-foreground shadow-lg"
                style={{
                  left: `${hoverFrac * 100}%`,
                  background: "#0c0e11",
                  borderColor: "hsl(var(--axis-z) / 0.4)",
                }}
              >
                → {machineZAtFrac(hoverFrac).toFixed(1)} {t("common:unit.mm")}
              </div>
            </>
          )}

          {/* Live-position thumb */}
          <div
            className="pointer-events-none absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-[5px] shadow-[0_1px_4px_rgba(0,0,0,.4)]"
            style={{ left: `${thumbFrac * 100}%`, background: "hsl(var(--axis-z))" }}
          />
        </div>

        <button type="button" title="Z+" disabled={!enabled} className={Z_BTN} {...zProps(1)}>
          <ChevronUp className="size-4" />
        </button>
      </div>

      {/* Caption */}
      <div className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        {t("toolChange.manualBarHint")}
        {lastFrac != null && (
          <>
            {" "}
            <span style={{ color: "#e8c14a" }}>{t("toolChange.manualBarMark")}</span>{" "}
            {t("toolChange.manualBarMarkRest")}
          </>
        )}
      </div>
    </div>
  );
}
