import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useJog } from "@/hooks/useJog";
import { cn } from "@/lib/utils";

/** Z± button — a compact square at each end of the strip (matches the jog pad style). */
const zBtn =
  "grid h-[30px] w-[38px] shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground active:bg-primary/10 disabled:pointer-events-none disabled:opacity-30";

/** Horizontal Z touch-off strip for the work-zero screen: `Z−` | draggable track | `Z+`.
 *  Lowers/raises the spindle in the MACHINE frame to aim at the datum corner — it does
 *  NOT bind Z (that is probed per bit at run time). The track maps machine Z over the
 *  travel `[-maxZMm, 0]` (left = lowest, right = the homed ceiling); the thumb tracks the
 *  live position. Clicking the track jogs Z to that height (cancel-then-retarget, like
 *  the vertical Z bar) — no per-move flood; the Z± buttons step- or hold-jog. */
export function ZTouchOffStrip({ maxZMm }: { maxZMm: number }) {
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
  const { enabled, continuous, go, startContinuous, stopContinuous, jogTo } = useJog({ bounds });

  // Stop any in-flight continuous jog on unmount.
  useEffect(() => () => stopContinuous(), [stopContinuous]);

  const trackRef = useRef<HTMLDivElement>(null);
  const range = maxZMm || 1;
  // Thumb position: fraction of the travel from the bottom (left) to the ceiling (right).
  const thumbFrac = Math.min(1, Math.max(0, (mz + maxZMm) / range));

  // Machine Z under the cursor on the track (left edge = -maxZMm, right edge = 0).
  const machineZAt = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return mz;
    const r = el.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return -maxZMm + f * maxZMm;
  };

  const onTrackClick = (e: React.MouseEvent) => {
    if (!enabled) return;
    // jogTo takes WORK coordinates; convert from the machine Z the track maps.
    void jogTo({ z: machineZAt(e.clientX) - wcoZ });
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
    <div className="flex items-center gap-2">
      <button type="button" title="Z−" disabled={!enabled} className={zBtn} {...zProps(-1)}>
        <ChevronDown className="size-4" />
      </button>

      <div
        ref={trackRef}
        onClick={onTrackClick}
        className={cn(
          "relative h-[30px] flex-1 overflow-hidden rounded-md border border-border bg-background/70",
          enabled && "cursor-pointer",
        )}
      >
        {/* Scale ticks every 16px */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              "repeating-linear-gradient(to right, hsl(var(--border) / .6) 0 1px, transparent 1px 16px)",
          }}
        />
        {/* Live-position thumb */}
        <div
          className="pointer-events-none absolute bottom-[3px] top-[3px] w-4 -translate-x-1/2 rounded-[5px] shadow-[0_1px_4px_rgba(0,0,0,.4)]"
          style={{ left: `${thumbFrac * 100}%`, background: "hsl(var(--axis-z))" }}
        />
      </div>

      <button type="button" title="Z+" disabled={!enabled} className={zBtn} {...zProps(1)}>
        <ChevronUp className="size-4" />
      </button>
    </div>
  );
}
