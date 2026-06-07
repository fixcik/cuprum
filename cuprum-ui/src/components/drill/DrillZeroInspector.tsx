import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ChevronLeft } from "lucide-react";
import type { DatumCorner } from "@/lib/datum";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import type { XYGateResult } from "@/lib/xyGate";
import { useMachine } from "@/machineStore";
import { canMove } from "@/lib/machineControls";
import { Button } from "@/components/ui/Button";
import { WorkZeroCard } from "@/components/drill/WorkZeroCard";
import { DrillTableMap } from "@/components/drill/DrillTableMap";
import { DatumCornerPicker } from "@/components/ui/DatumCornerPicker";

export interface DrillZeroInspectorProps {
  /** Active datum corner. */
  datum: DatumCorner;
  onDatumChange: (d: DatumCorner) => void;
  /** Back to the plan inspector. */
  onBack: () => void;
  /** Whether the work zero is bound (drives the "set" header badge). */
  isSet: boolean;
  /** Selected sub-plan — holes drawn as dots on the board-on-bed map. */
  plan: PanelDrillPlan;
  panelWidthMm: number;
  panelHeightMm: number;
  /** MPos Z captured at bind (null = not bound). */
  workZeroMachineZ: number | null;
  safeZMm: number;
  maxXMm: number;
  maxYMm: number;
  maxZMm: number;
  xyGate: XYGateResult;
  onBind: () => void;
  onClear: () => void;
  /** Last work-zero bind error from GRBL (null = none). */
  zeroError: string | null;
}

/** Inspector mode for binding the work zero. Lives inside the right sidebar — the
 *  canvas stays put when switching to/from this mode. Holds the datum-corner grid,
 *  the board-on-bed mini-map (travel-fit check + click-to-move), the jog/Z/bind
 *  controls (WorkZeroCard), and the GRBL bind-error banner. */
export function DrillZeroInspector({
  datum,
  onDatumChange,
  onBack,
  isSet,
  plan,
  panelWidthMm,
  panelHeightMm,
  workZeroMachineZ,
  safeZMm,
  maxXMm,
  maxYMm,
  maxZMm,
  xyGate,
  onBind,
  onClear,
  zeroError,
}: DrillZeroInspectorProps) {
  const { t } = useTranslation("drill");
  // Whether the machine can move (connected + idle/jog-safe) — gates the bind action.
  const canBind = useMachine((s) => canMove(s.status.state, s.connected));

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
        {isSet && (
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

        {/* Jog + Z controls (the bind/reset actions live in the sticky footer) */}
        <WorkZeroCard
          workZeroMachineZ={workZeroMachineZ}
          safeZMm={safeZMm}
          maxXMm={maxXMm}
          maxYMm={maxYMm}
          maxZMm={maxZMm}
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

      {/* Sticky footer: bind / reset actions pinned to the bottom */}
      <div className="sticky bottom-0 mt-auto flex shrink-0 gap-2 border-t border-border bg-panel p-3">
        <Button size="sm" disabled={!canBind} onClick={onBind} className="flex-1">
          {t("workzero.bind")}
        </Button>
        <Button size="sm" variant="secondary" disabled={!isSet} onClick={onClear}>
          {t("workzero.reset")}
        </Button>
      </div>
    </>
  );
}
