import { useTranslation } from "react-i18next";
import { MousePointerClick } from "lucide-react";
import type { Pt } from "@/components/machine/workFieldDraw";

/** Presentational overlays drawn over the {@link WorkField} canvas: the hovered
 *  WORK-coordinate readout (top-left) and the click hint (bottom-right). Both are
 *  pointer-inert so they never steal events from the canvas integrator. The
 *  hovered WORK coords are computed by the parent (envelope hover − wco) and
 *  passed in already converted. */
export function WorkFieldHud({ hover, allowPick }: { hover: Pt | null; allowPick: boolean }) {
  const { t } = useTranslation("machine");
  return (
    <>
      {hover && allowPick && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-md border border-border bg-popover/90 px-2 py-1 font-mono text-[10px] tabular-nums text-muted-foreground backdrop-blur">
          → X{hover.x.toFixed(1)} Y{hover.y.toFixed(1)}
        </div>
      )}
      {allowPick && (
        <div className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded-md border border-border bg-popover/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur">
          <MousePointerClick className="size-3" /> {t("field.clickHint")}
        </div>
      )}
    </>
  );
}
