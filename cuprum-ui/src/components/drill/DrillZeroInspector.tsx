import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ChevronLeft } from "lucide-react";
import type { DatumCorner } from "@/lib/datum";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { XYGateResult } from "@/lib/xyGate";
import { api } from "@/lib/api";
import { useMachine } from "@/machineStore";
import { useUnlockSuppressed } from "@/hooks/useUnlockSuppressed";
import { canMove } from "@/lib/machineControls";
import { Button } from "@/components/ui/Button";
import { AlarmActions } from "@/components/machine/AlarmActions";
import { WorkZeroCard } from "@/components/drill/WorkZeroCard";
import { DrillTableMap } from "@/components/drill/DrillTableMap";
import { DatumCornerPicker } from "@/components/ui/DatumCornerPicker";

export interface DrillZeroInspectorProps {
  /** Active datum corner. */
  datum: DatumCorner;
  onDatumChange: (d: DatumCorner) => void;
  /** Back to the plan inspector. */
  onBack: () => void;
  /** Whether the XY work zero is bound (drives the "set" header badge). */
  workZeroSet: boolean;
  /** Selected sub-plan — holes drawn as dots on the board-on-bed map. */
  plan: PanelDrillPlan;
  panelWidthMm: number;
  panelHeightMm: number;
  maxXMm: number;
  maxYMm: number;
  maxZMm: number;
  xyGate: XYGateResult;
  /** Bind the work zero. Returns true on success → the mode closes back to plan. */
  onBind: () => boolean | Promise<boolean>;
  onClear: () => void;
  /** Last work-zero bind error from GRBL (null = none). */
  zeroError: string | null;
}

/** Inspector mode for binding the work zero. Lives inside the right sidebar — the
 *  canvas stays put when switching to/from this mode. Holds the datum-corner grid,
 *  the board-on-bed mini-map (travel-fit check + click-to-move), the XY jog/bind
 *  controls (WorkZeroCard), and the GRBL bind-error banner. */
export function DrillZeroInspector({
  datum,
  onDatumChange,
  onBack,
  workZeroSet,
  plan,
  panelWidthMm,
  panelHeightMm,
  maxXMm,
  maxYMm,
  maxZMm,
  xyGate,
  onBind,
  onClear,
  zeroError,
}: DrillZeroInspectorProps) {
  const { t } = useTranslation("drill");
  const { t: tm } = useTranslation("machine");
  // Whether the machine can move (connected + idle/jog-safe) — gates the bind action.
  const machineState = useMachine((s) => s.status.state);
  const connected = useMachine((s) => s.connected);
  const canBind = canMove(machineState, connected);
  // Hide the alarm reason at once when unlock is pressed in any window.
  const unlockSuppressed = useUnlockSuppressed();
  // Local in-flight guard so the bind button shows a disabled state during the
  // async setZero round-trip (otherwise it looks unresponsive on slow GRBL links).
  const [isBinding, setIsBinding] = useState(false);

  return (
    <>
      {/* Mode header: back to plan + title + bound badge */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 shrink-0">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          {t("zeroMode.back")}
        </button>
        <span className="text-sm font-semibold text-foreground">{t("zeroMode.title")}</span>
        {workZeroSet && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] text-primary">
            <CheckCircle2 className="size-3" />
            {t("zeroMode.bound")}
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col overflow-y-auto">
        {/* Datum corner — 2×2 grid */}
        <div className="px-4 py-3">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("zeroMode.datumLabel")}
          </p>
          <DatumCornerPicker value={datum} onChange={onDatumChange} />
        </div>

        {/* Board-on-bed mini-map: travel-fit check + click-to-move */}
        <div className="px-4 pb-1">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t("tableMap.label")}
          </p>
          <DrillTableMap
            plan={plan}
            datum={datum}
            panelWidthMm={panelWidthMm}
            panelHeightMm={panelHeightMm}
            maxXMm={maxXMm}
            maxYMm={maxYMm}
            maxZMm={maxZMm}
          />
        </div>

        {/* XY jog controls (the bind/reset actions live in the sticky footer) */}
        <WorkZeroCard
          workZeroSet={workZeroSet}
          maxXMm={maxXMm}
          maxYMm={maxYMm}
          xyGate={xyGate}
        />

        {/* Work-zero bind error from GRBL (command rejected → zero NOT set). */}
        {zeroError && (
          <div className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t("zero.bindRejected", { error: zeroError })}</span>
          </div>
        )}
      </div>

      {/* Why the bind is disabled — surfaced here so the operator needn't open the
          Equipment window to discover the machine is in alarm / busy / offline. The
          alarm case offers in-place recovery (unlock / soft-reset / console). */}
      {!canBind && !(machineState === "alarm" && unlockSuppressed) && (
        <div className="shrink-0 px-3 pb-2">
          {!connected ? (
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{t("zeroMode.blocked.disconnected")}</span>
            </div>
          ) : machineState === "alarm" ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              <div className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>{tm("alarm")}</span>
              </div>
              <div className="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void api.machine.softReset()}
                  className="rounded-md border border-current/40 px-2 py-1 text-[11px] font-medium hover:bg-current/10"
                >
                  {tm("controls.softReset")}
                </button>
                <AlarmActions />
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-[11px] text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>{t("zeroMode.blocked.busy", { state: tm(`state.${machineState}`) })}</span>
            </div>
          )}
        </div>
      )}

      {/* Sticky footer: bind / reset actions pinned to the bottom */}
      <div className="sticky bottom-0 mt-auto flex shrink-0 gap-2 border-t border-border bg-panel p-3">
        <Button
          size="sm"
          disabled={!canBind || isBinding}
          onClick={async () => {
            if (isBinding) return;
            setIsBinding(true);
            try {
              // On a successful bind, leave the zero mode and return to the plan.
              if (await onBind()) onBack();
            } finally {
              setIsBinding(false);
            }
          }}
          className="flex-1"
        >
          {t("workzero.bind")}
        </Button>
        <Button size="sm" variant="secondary" disabled={!workZeroSet} onClick={onClear}>
          {t("workzero.reset")}
        </Button>
      </div>
    </>
  );
}
