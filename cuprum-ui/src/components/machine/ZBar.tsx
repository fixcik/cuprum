import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { cn } from "@/lib/utils";

/** Vertical Z scale beside the work field. Fill height tracks the tool's machine
 *  Z within the envelope [-env.z, 0]; a primary tick marks the work zero (wco.z).
 *  The bottom label shows the live work Z. */
export function ZBar({ className }: { className?: string }) {
  const env = useSettings((s) => s.cncProfile.workEnvelopeMm);
  const status = useMachine((s) => s.status);
  const mz = status.mpos[2];
  const wz = status.wpos[2];
  const wcoZ = mz - wz;

  const zMin = -env.z;
  const zMax = 0;
  const range = zMax - zMin || 1;
  const fillPct = Math.max(2, ((mz - zMin) / range) * 100);
  const zeroPct = ((wcoZ - zMin) / range) * 100;

  return (
    <div className={cn("flex flex-col items-center gap-1.5", className)}>
      <span className="text-[10px] font-semibold uppercase text-axis-z">Z</span>
      <div className="relative w-2.5 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className="absolute inset-x-0 bottom-0 rounded-full bg-axis-z/70"
          style={{ height: `${fillPct}%` }}
        />
        <div
          className="absolute inset-x-[-3px] h-[1.5px] bg-primary"
          style={{ bottom: `${zeroPct}%` }}
        />
      </div>
      <span className="font-mono text-[10px] tabular-nums text-muted-foreground">{wz.toFixed(1)}</span>
    </div>
  );
}
