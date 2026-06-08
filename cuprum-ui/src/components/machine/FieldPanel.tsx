import { useTranslation } from "react-i18next";
import { Grid3x3 } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import { canMove } from "@/lib/machineControls";
import { useJog, RAPID_JOG_FEED } from "@/hooks/useJog";
import { WorkField } from "@/components/machine/WorkField";
import { ZBar } from "@/components/machine/ZBar";

/** Work-area card: header (envelope size + live work XYZ) over the WorkField +
 *  ZBar. Clicking the field traverses straight to the picked WORK X/Y at the
 *  current Z — Z is left untouched. (An automatic raise-to-safe-Z used to run
 *  first, but it was non-obvious and got in the operator's way during manual
 *  setup; if clearance is needed they raise Z themselves via the ZBar.)
 *  The field is inert unless connected, movable and homed. */
export function FieldPanel({ className }: { className?: string }) {
  const { t } = useTranslation("machine");
  const env = useSettings((s) => s.cncProfile.workEnvelopeMm);
  const connected = useMachine((s) => s.connected);
  const state = useMachine((s) => s.status.state);
  const wpos = useMachine((s) => s.status.wpos);
  const homed = useMachine((s) => s.homed);
  const movable = canMove(state, connected);
  // The picked target is an absolute WORK position, only meaningful on a
  // referenced frame, so require homing in addition to a movable state.
  const canAutoMove = movable && homed;
  const { jogTo } = useJog();

  /** Field click: traverse XY straight to the picked WORK target as a rapid-like
   *  JOG (not a G0 rapid) so it stays in the `jog` state — the field stays live
   *  and a fresh click cancels-and-retargets via jogTo. Z is left untouched. */
  function requestMove(x: number, y: number) {
    // Re-validate live state: the machine may have disconnected / alarmed / lost
    // homing between the click and the move. Bail rather than send into an
    // unsafe state.
    const m = useMachine.getState();
    if (!m.connected || !m.homed || !canMove(m.status.state, m.connected)) return;
    void jogTo({ x, y }, RAPID_JOG_FEED).catch((e) => console.error("field move failed", e));
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
