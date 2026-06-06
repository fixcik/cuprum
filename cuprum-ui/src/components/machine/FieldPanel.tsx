import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Grid3x3 } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { WorkField } from "@/components/machine/WorkField";
import { ZBar } from "@/components/machine/ZBar";

interface PendingMove {
  x: number;
  y: number;
}

/** Work-area card: header (envelope size + live work XYZ) over the WorkField +
 *  ZBar. Clicking the field rapids to the picked WORK X/Y. If the tool is already
 *  at/above the machine safe-Z it moves straight away; otherwise it asks whether
 *  to raise Z to the safe height first (raise-then-move) or travel as-is. The
 *  field is inert unless the machine is connected and in a movable state. */
export function FieldPanel({ className }: { className?: string }) {
  const { t } = useTranslation("machine");
  const env = useSettings((s) => s.cncProfile.workEnvelopeMm);
  const safeZMm = useSettings((s) => s.cncProfile.safeZMm);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const wpos = useMachine((s) => s.status.wpos);
  const movable = canMove(state, connected);

  // A move awaiting the raise-or-not choice (only set when Z is below safe-Z).
  const [pending, setPending] = useState<PendingMove | null>(null);

  async function move(x: number, y: number, raiseFirst: boolean) {
    if (raiseFirst) await api.machine.send(`G90 G0 Z${safeZMm}`);
    await api.machine.send(`G90 G0 X${x.toFixed(3)} Y${y.toFixed(3)}`);
  }

  /** Field click: move straight away when already clear of stock (Z ≥ safe-Z),
   *  otherwise ask whether to lift Z first. Z is read live at click time. */
  function requestMove(x: number, y: number) {
    const currentZ = useMachine.getState().status.wpos[2];
    if (currentZ >= safeZMm) {
      void move(x, y, false);
    } else {
      setPending({ x, y });
    }
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
        <WorkField className="flex-1" disabled={!movable} onPick={requestMove} />
        <ZBar className="py-1" />
      </div>

      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={t("field.goConfirm.title")}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t("field.goConfirm.cancel")}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (pending) void move(pending.x, pending.y, false);
                setPending(null);
              }}
            >
              {t("field.goConfirm.direct")}
            </Button>
            <Button
              variant="default"
              onClick={() => {
                if (pending) void move(pending.x, pending.y, true);
                setPending(null);
              }}
            >
              {t("field.goConfirm.raise")}
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-muted-foreground">
          {pending
            ? t("field.goConfirm.message", {
                x: pending.x.toFixed(1),
                y: pending.y.toFixed(1),
                z: safeZMm,
              })
            : ""}
        </p>
      </Modal>
    </section>
  );
}
