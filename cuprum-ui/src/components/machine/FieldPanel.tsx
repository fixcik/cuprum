import { useTranslation } from "react-i18next";
import { Grid3x3 } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { api } from "@/lib/api";
import { canMove } from "@/lib/machineControls";
import { safeRetractMachineZ } from "@/lib/gotoZero";
import { useJog, RAPID_JOG_FEED } from "@/hooks/useJog";
import { WorkField } from "@/components/machine/WorkField";
import { ZBar } from "@/components/machine/ZBar";

/** Work-area card: header (envelope size + live work XYZ) over the WorkField +
 *  ZBar. Clicking the field moves to the picked WORK X/Y. If the tool is already
 *  at/above the machine safe-Z it traverses straight away (as a rapid-like jog,
 *  so a fresh click cancels-and-retargets instead of blocking); otherwise it
 *  raises Z to the safe height first (raise-then-move) — no confirmation prompt.
 *  The field is inert unless the machine is connected and in a movable state. */
export function FieldPanel({ className }: { className?: string }) {
  const { t } = useTranslation("machine");
  const env = useSettings((s) => s.cncProfile.workEnvelopeMm);
  const safeZMm = useSettings((s) => s.cncProfile.safeZMm);
  const machineSafeZMm = useSettings((s) => s.cncProfile.machineSafeZMm);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const wpos = useMachine((s) => s.status.wpos);
  const homed = useMachine((s) => s.homed);
  const movable = canMove(state, connected);
  // The click-to-move traverse does a machine-frame (G53) safe-Z retract, so it
  // requires a homed frame in addition to a movable state.
  const canAutoMove = movable && homed;
  const { jogTo } = useJog();

  async function move(x: number, y: number, raiseFirst: boolean) {
    // Re-validate live state: the machine may have disconnected / alarmed / lost
    // homing between the click and the move. Bail rather than send into an
    // unsafe state.
    const m = useMachine.getState();
    if (!m.connected || !m.homed || !canMove(m.status.state, m.connected)) return;
    try {
      if (raiseFirst) {
        // Lift Z to a clearance above the work zero (MACHINE frame, G53) BEFORE
        // traversing, so the tool can't drag through stock. This ordered pair must
        // stay rapids — a single jog can't sequence "raise fully, then move".
        const retractZ = safeRetractMachineZ(
          m.status.mpos[2] - m.status.wpos[2],
          safeZMm,
          machineSafeZMm,
        );
        await api.machine.send(`G53 G0 Z${retractZ}`);
        await api.machine.send(`G90 G0 X${x.toFixed(3)} Y${y.toFixed(3)}`);
      } else {
        // Already clear of stock: traverse XY as a rapid-like JOG (not a G0 rapid)
        // so it stays in the `jog` state — the field stays live and a fresh click
        // cancels-and-retargets via jogTo instead of being blocked or queued.
        await jogTo({ x, y }, RAPID_JOG_FEED);
      }
    } catch (e) {
      console.error("field move failed", e);
    }
  }

  /** Field click: traverse straight away when already clear of stock (machine
   *  Z ≥ the safe retract target), otherwise raise Z to the safe height first.
   *  Z is read live at click time; no confirmation — the safe action is implicit. */
  function requestMove(x: number, y: number) {
    const m = useMachine.getState();
    const currentMachineZ = m.status.mpos[2];
    const retractZ = safeRetractMachineZ(
      m.status.mpos[2] - m.status.wpos[2],
      safeZMm,
      machineSafeZMm,
    );
    void move(x, y, currentMachineZ < retractZ);
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
        {connected && !homed && (
          <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-500">
            {t("controls.homeFirst")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 text-[12px] text-foreground">
          {axisLabel("X", "text-axis-x", wpos[0])}
          {axisLabel("Y", "text-axis-y", wpos[1])}
          {axisLabel("Z", "text-axis-z", wpos[2])}
        </div>
      </header>

      <div className="flex flex-1 gap-3 p-4">
        <WorkField className="flex-1" disabled={!canAutoMove} onPick={requestMove} />
        <ZBar className="py-1" />
      </div>
    </section>
  );
}
