import { useTranslation } from "react-i18next";
import {
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignCenterHorizontal,
  AlignEndHorizontal,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
  type LucideIcon,
} from "lucide-react";
import { usePanelSelection } from "@/panelSelectionStore";
import type { AlignEdge } from "@/lib/panelPlacement";

/** Floating align/distribute bar (bottom-centre of the panel canvas). Appears when
 *  ≥2 instances are selected; distribute needs ≥3. Presentational — actions are
 *  computed in PanelBlankCanvas (which holds resolved board sizes). */
export function PanelAlignBar({
  onAlign,
  onDistribute,
}: {
  onAlign: (edge: AlignEdge) => void;
  onDistribute: (axis: "h" | "v") => void;
}) {
  const { t } = useTranslation("project");
  const count = usePanelSelection((s) => s.selected.size);
  if (count < 2) return null;
  const canDistribute = count >= 3;

  const btn = (Icon: LucideIcon, label: string, onClick: () => void, disabled = false) => (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={[
        "grid size-9 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        disabled
          ? "cursor-not-allowed text-muted-foreground/30"
          : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
      ].join(" ")}
    >
      <Icon className="size-[18px]" />
    </button>
  );

  return (
    <div className="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-card/90 p-1.5 shadow-lg backdrop-blur">
      {btn(AlignStartVertical, t("panel.align.left"), () => onAlign("left"))}
      {btn(AlignCenterVertical, t("panel.align.hcenter"), () => onAlign("hcenter"))}
      {btn(AlignEndVertical, t("panel.align.right"), () => onAlign("right"))}
      <div className="mx-0.5 h-6 w-px bg-border" />
      {btn(AlignStartHorizontal, t("panel.align.top"), () => onAlign("top"))}
      {btn(AlignCenterHorizontal, t("panel.align.vmiddle"), () => onAlign("vmiddle"))}
      {btn(AlignEndHorizontal, t("panel.align.bottom"), () => onAlign("bottom"))}
      <div className="mx-0.5 h-6 w-px bg-border" />
      {btn(AlignHorizontalDistributeCenter, t("panel.align.distributeH"), () => onDistribute("h"), !canDistribute)}
      {btn(AlignVerticalDistributeCenter, t("panel.align.distributeV"), () => onDistribute("v"), !canDistribute)}
    </div>
  );
}
