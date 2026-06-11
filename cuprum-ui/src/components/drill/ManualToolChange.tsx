import { useTranslation } from "react-i18next";
import { ArrowDownToLine, Loader2, TriangleAlert } from "lucide-react";
import { DrillManualZBar } from "@/components/drill/DrillManualZBar";
import type { ZBindBand } from "@/lib/drillZHeadroom";

// Solid amber action button (manual confirm). Dark text on amber per the design
// tokens — never the muted translucent brown. Kept identical to the probe tab's
// button so the resume/confirm affordances read the same.
const SOLID_WARNING =
  "flex w-full items-center justify-center gap-2 rounded-lg bg-warning py-2.5 text-[13px] font-semibold text-[hsl(38_60%_12%)] transition-opacity hover:opacity-90 disabled:opacity-50";

/** Manual Z touch-off tab of the tool-change card: jog the bit down (via the
 *  {@link DrillManualZBar}) to kiss the copper, then confirm to set work-Z. The
 *  parent owns the shared state (`busy`, `enabled`) and the setZero side effect;
 *  this is a pure presentation of the manual flow. */
export function ManualToolChange({
  lastManualZMm,
  enabled,
  busy,
  band,
  bindBlock,
  onConfirm,
}: {
  /** Machine Z (mm) of the last manual touch-off this session — the yellow
   *  «previous Z» mark on the bar. Null until the first manual confirm. */
  lastManualZMm: number | null;
  /** Motion allowed (connected + idle) — gates the confirm button. */
  enabled: boolean;
  /** A probe/manual action is in flight. */
  busy: boolean;
  /** Safe machine-Z bind band — paints the forbidden zones on the bar. */
  band?: ZBindBand | null;
  /** The live bit position is in a forbidden zone: "below" (floor) / "above" (ceiling) /
   *  null (safe). When set, binding here would trip the envelope, so the confirm is
   *  gated up front — the zero is never set outside the band. */
  bindBlock: "below" | "above" | null;
  /** Record the touch-off Z and bind the work zero. */
  onConfirm: () => void;
}) {
  const { t } = useTranslation("drill");

  return (
    <div className="flex flex-col gap-2">
      <DrillManualZBar lastZMm={lastManualZMm} band={band} />
      {bindBlock && (
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-red-400">
          <TriangleAlert className="size-3.5 shrink-0" />
          {bindBlock === "below" ? t("toolChange.zoneTooLow") : t("toolChange.zoneTooHigh")}
        </div>
      )}
      <button
        type="button"
        className={SOLID_WARNING}
        disabled={!enabled || busy || bindBlock != null}
        onClick={onConfirm}
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowDownToLine className="size-4" />}
        {t("toolChange.manualConfirm")}
      </button>
    </div>
  );
}
