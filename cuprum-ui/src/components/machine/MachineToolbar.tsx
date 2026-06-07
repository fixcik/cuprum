import { Fan, Gauge } from "lucide-react";
import { useMachine } from "@/machineStore";
import { api } from "@/lib/api";
import { ConnBar } from "@/components/machine/ConnBar";
import { QuickActions } from "@/components/machine/QuickActions";
import { StatusPill } from "@/components/machine/StatusPill";
import { EStop } from "@/components/machine/EStop";

/** Status/connection toolbar: ConnBar on the left, the machine action buttons
 *  (home / unlock / hold / resume / soft reset) pushed to the right, then a
 *  feed/spindle mini-readout + big StatusPill + compact E-Stop. The E-Stop is
 *  the Phase-1 emergency stop: it fires a soft reset immediately, without
 *  confirmation. */
export function MachineToolbar() {
  const feed = useMachine((s) => s.status.feed);
  const spindle = useMachine((s) => s.status.spindle);

  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-2">
      <ConnBar />
      <QuickActions className="ml-auto" />
      <div className="h-6 w-px bg-border" />
      <div className="flex items-center gap-3">
        {/* Hide the numeric readout on narrow widths to keep the toolbar tidy. */}
        <div className="hidden items-center gap-3 font-mono text-[11px] tabular-nums text-muted-foreground xl:flex">
          <span className="inline-flex items-center gap-1">
            <Gauge className="size-3.5" />F{Math.round(feed)}
          </span>
          <span className="inline-flex items-center gap-1">
            <Fan className="size-3.5" />S{Math.round(spindle)}
          </span>
        </div>
        <StatusPill big />
        <div className="h-6 w-px bg-border" />
        <EStop compact onClick={() => void api.machine.softReset()} />
      </div>
    </div>
  );
}
