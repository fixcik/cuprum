import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Grid3x3 } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { WorkField } from "@/components/machine/WorkField";
import { ZBar } from "@/components/machine/ZBar";

interface PendingMove {
  x: number;
  y: number;
}

/** Work-area card: header (envelope size + live work XYZ) over the WorkField +
 *  ZBar. Clicking the field arms a confirm dialog; on confirm it raises Z to the
 *  machine safe-Z, then rapids to the picked WORK X/Y. The field is inert unless
 *  the machine is connected and in a movable state (Idle/Jog). */
export function FieldPanel({ className }: { className?: string }) {
  const { t } = useTranslation("machine");
  const env = useSettings((s) => s.cncProfile.workEnvelopeMm);
  const safeZMm = useSettings((s) => s.cncProfile.safeZMm);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const wpos = useMachine((s) => s.status.wpos);
  const movable = canMove(state, connected);

  const [pending, setPending] = useState<PendingMove | null>(null);

  function confirmMove() {
    if (!pending) return;
    const { x, y } = pending;
    // Raise to safe Z first, then rapid to the target in work coordinates.
    void api.machine.send(`G90 G0 Z${safeZMm}`);
    void api.machine.send(`G90 G0 X${x.toFixed(3)} Y${y.toFixed(3)}`);
  }

  const axisLabel = (label: string, tone: string, value: number) => (
    <span className="inline-flex items-baseline gap-1 font-mono tabular-nums">
      <span className={tone}>{label}</span>
      {value.toFixed(2)}
    </span>
  );

  return (
    <section className={`flex flex-col rounded-xl border border-border bg-card ${className ?? ""}`}>
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Grid3x3 className="size-4 text-muted-foreground" />
        <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("field.title")}
        </span>
        <span className="rounded-md border border-border bg-muted/40 px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {env.x} × {env.y} {t("field.mm")}
        </span>
        <div className="ml-auto flex items-center gap-3 text-[12px] text-foreground">
          {axisLabel("X", "text-axis-x", wpos[0])}
          {axisLabel("Y", "text-axis-y", wpos[1])}
          {axisLabel("Z", "text-axis-z", wpos[2])}
        </div>
      </header>

      <div className="flex flex-1 gap-3 p-4">
        <WorkField
          className="flex-1"
          disabled={!movable}
          onPick={(x, y) => setPending({ x, y })}
        />
        <ZBar className="py-1" />
      </div>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        onConfirm={confirmMove}
        destructive={false}
        title={t("field.goConfirm.title")}
        message={
          pending
            ? t("field.goConfirm.message", {
                x: pending.x.toFixed(1),
                y: pending.y.toFixed(1),
                z: safeZMm,
              })
            : ""
        }
        confirmLabel={t("field.goConfirm.confirm")}
        cancelLabel={t("field.goConfirm.cancel")}
      />
    </section>
  );
}
