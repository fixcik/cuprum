import { useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { useJog } from "@/hooks/useJog";
import { machineZFromFraction } from "@/lib/zbar";
import { cn } from "@/lib/utils";

const zBtn =
  "grid h-7 w-7 shrink-0 place-items-center rounded-md border border-border bg-background text-muted-foreground transition-all hover:border-primary/50 hover:text-foreground active:scale-95 active:text-primary disabled:opacity-30 disabled:pointer-events-none";

/** Vertical Z scale beside the work field. Fill height tracks the tool's machine
 *  Z within the envelope [-env.z, 0]; a primary tick marks the work zero (wco.z).
 *  Interactive: the Z± buttons step-jog (sharing the jog pad's step), and the
 *  track itself is click-to-level — clicking a height jogs Z toward that level
 *  (feed-limited + envelope-clamped). The bottom label shows the live work Z. */
export function ZBar({ className }: { className?: string }) {
  const env = useSettings((s) => s.cncProfile.workEnvelopeMm);
  const status = useMachine((s) => s.status);
  const mz = status.mpos[2];
  const wz = status.wpos[2];
  const wcoZ = mz - wz;
  const { enabled, continuous, go, startContinuous, stopContinuous, jogTo } = useJog();

  const zMin = -env.z;
  const range = env.z || 1;
  const fillPct = Math.max(2, ((mz - zMin) / range) * 100);
  const zeroPct = ((wcoZ - zMin) / range) * 100;

  const trackRef = useRef<HTMLDivElement>(null);
  // Hover preview of the click target: the WORK Z at the cursor + its vertical
  // position (% from the top) so the label can sit beside the cursor.
  const [hover, setHover] = useState<{ workZ: number; topPct: number } | null>(null);

  /** Fraction of the track height the cursor sits at, measured from the bottom. */
  const fracFromBottom = (clientY: number): number => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return 1 - (clientY - r.top) / r.height;
  };

  const onTrackClick = (e: React.MouseEvent) => {
    if (!enabled) return;
    const targetMachineZ = machineZFromFraction(fracFromBottom(e.clientY), env.z);
    // jogTo takes WORK coordinates; convert from the machine Z the bar maps.
    void jogTo({ z: targetMachineZ - wcoZ });
  };

  const onTrackMove = (e: React.MouseEvent) => {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const targetMachineZ = machineZFromFraction(fracFromBottom(e.clientY), env.z);
    setHover({ workZ: targetMachineZ - wcoZ, topPct: ((e.clientY - r.top) / r.height) * 100 });
  };

  // Z± buttons: step jog (click) or continuous (hold) — mirrors the jog pad's Z
  // column, both sharing the same active step via useJog.
  const zProps = (dz: number) =>
    continuous
      ? {
          onPointerDown: (e: ReactPointerEvent) => {
            e.preventDefault();
            void startContinuous(0, 0, dz);
          },
          onPointerUp: () => stopContinuous(),
          onPointerLeave: () => stopContinuous(),
          onPointerCancel: () => stopContinuous(),
        }
      : { onClick: () => go(0, 0, dz) };

  return (
    <div className={cn("flex flex-col items-center gap-1.5", className)}>
      <span className="text-[10px] font-semibold uppercase text-axis-z">Z</span>
      <button type="button" title="Z+ (PgUp)" disabled={!enabled} className={zBtn} {...zProps(1)}>
        <ChevronUp className="size-4" />
      </button>
      <div className="relative flex w-full flex-1 justify-center">
        <div
          ref={trackRef}
          onClick={onTrackClick}
          onMouseMove={onTrackMove}
          onMouseLeave={() => setHover(null)}
          className={cn(
            "relative w-2.5 flex-1 overflow-hidden rounded-full bg-muted",
            enabled && "cursor-pointer",
          )}
        >
          <div
            className="absolute inset-x-0 bottom-0 rounded-full bg-axis-z/70"
            style={{ height: `${fillPct}%` }}
          />
          <div
            className="absolute inset-x-[-3px] h-[1.5px] bg-primary"
            style={{ bottom: `${zeroPct}%` }}
          />
        </div>
        {hover && enabled && (
          <div
            className="pointer-events-none absolute right-full mr-1.5 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-popover/90 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground backdrop-blur"
            style={{ top: `${hover.topPct}%` }}
          >
            → Z{hover.workZ.toFixed(1)}
          </div>
        )}
      </div>
      <button type="button" title="Z− (PgDn)" disabled={!enabled} className={zBtn} {...zProps(-1)}>
        <ChevronDown className="size-4" />
      </button>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{wz.toFixed(1)}</span>
    </div>
  );
}
