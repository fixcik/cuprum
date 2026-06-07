import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2, ChevronLeft } from "lucide-react";
import type { DatumCorner } from "@/lib/datum";
import type { XYGateResult } from "@/lib/xyGate";
import { WorkZeroCard } from "@/components/drill/WorkZeroCard";
import { DatumCornerPicker } from "@/components/ui/DatumCornerPicker";

export interface DrillZeroInspectorProps {
  /** Active datum corner. */
  datum: DatumCorner;
  onDatumChange: (d: DatumCorner) => void;
  /** Back to the plan inspector. */
  onBack: () => void;
  /** Whether the work zero is bound (drives the "set" header badge). */
  isSet: boolean;
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
 *  the jog/Z/bind controls (WorkZeroCard), and the GRBL bind-error banner. The
 *  board-on-bed mini-map is added in a follow-up phase. */
export function DrillZeroInspector({
  datum,
  onDatumChange,
  onBack,
  isSet,
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

        {/* Jog + Z + bind controls */}
        <WorkZeroCard
          workZeroMachineZ={workZeroMachineZ}
          safeZMm={safeZMm}
          maxXMm={maxXMm}
          maxYMm={maxYMm}
          maxZMm={maxZMm}
          xyGate={xyGate}
          onBind={onBind}
          onClear={onClear}
        />

        {/* Work-zero bind error from GRBL (command rejected → zero NOT set). */}
        {zeroError && (
          <div className="mx-4 mb-3 flex items-start gap-2 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>{t("zero.bindRejected", { error: zeroError })}</span>
          </div>
        )}
      </div>
    </>
  );
}
