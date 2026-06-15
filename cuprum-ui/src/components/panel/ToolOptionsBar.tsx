import { useTranslation } from "react-i18next";
import { MousePointer2, Hand, Target, OctagonAlert, CircleDot, Grid2x2, Crosshair, Magnet, type LucideIcon } from "lucide-react";
import { RULER_TOP, RULER_OVERLAY_GAP } from "@/components/editor/canvasStyle";
import { UnitField } from "@/components/ui/settings/UnitField";
import { usePanelTool } from "@/panelToolStore";
import type { PanelTool } from "@/components/panel/PanelToolPalette";

/** Horizontal context bar of options for the active tool, centred at the top of
 *  the panel canvas. This is the heart of variant C: it replaces the rail's swapped
 *  icons with honest settings. The rail set never changes; only this bar does.
 *
 *  Tooling is a hybrid: "single" is a canvas sub-mode (click places a hole with the
 *  chosen Ø), while "set" and "auto" are commands that open the existing rich dialogs.
 *  Keep-out exposes a functional snap toggle. Select/pan show a label + hint so the
 *  bar doesn't flicker in and out as the tool changes. */
export function ToolOptionsBar({
  tool,
  onAddHole,
  addArmed,
  onAddRegistrationSet,
  onAddAutoFiducials,
}: {
  tool: PanelTool;
  onAddHole: () => void;
  addArmed: boolean;
  onAddRegistrationSet: () => void;
  onAddAutoFiducials: () => void;
}) {
  const { t } = useTranslation("project");
  const holeDiameterMm = usePanelTool((s) => s.holeDiameterMm);
  const setHoleDiameterMm = usePanelTool((s) => s.setHoleDiameterMm);
  const keepOutSnap = usePanelTool((s) => s.keepOutSnap);
  const setKeepOutSnap = usePanelTool((s) => s.setKeepOutSnap);

  const divider = <div className="h-5 w-px bg-border" />;

  const label = (Icon: LucideIcon, text: string) => (
    <span className="flex items-center gap-1.5 text-[12px] font-semibold text-foreground">
      <Icon className="size-[15px] text-primary" />
      {text}
    </span>
  );

  const chip = (Icon: LucideIcon, text: string, on: boolean, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={[
        "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11.5px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        on
          ? "border-primary/55 bg-primary/15 text-primary"
          : "border-border text-foreground/80 hover:bg-foreground/10",
      ].join(" ")}
    >
      <Icon className="size-[14px]" />
      {text}
    </button>
  );

  const command = (Icon: LucideIcon, text: string, onClick: () => void) => (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-[11.5px] text-foreground/80 transition-colors hover:bg-foreground/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon className="size-[14px]" />
      {text}
    </button>
  );

  const hint = (text: string) => <span className="text-[11px] text-muted-foreground">{text}</span>;

  let content: React.ReactNode;
  switch (tool) {
    case "tooling":
      content = (
        <>
          {label(Target, t("panel.tool.tooling"))}
          {divider}
          {chip(CircleDot, t("panel.toolbar.single"), addArmed, onAddHole)}
          <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
            Ø
            <UnitField value={holeDiameterMm} onChange={setHoleDiameterMm} dim="fine" className="w-20" />
          </span>
          {divider}
          {command(Grid2x2, t("panel.toolbar.set"), onAddRegistrationSet)}
          {command(Crosshair, t("panel.toolbar.auto"), onAddAutoFiducials)}
        </>
      );
      break;
    case "keepout":
      content = (
        <>
          {label(OctagonAlert, t("panel.tool.keepout"))}
          {divider}
          {chip(Magnet, t("panel.toolbar.snapGrid"), keepOutSnap, () => setKeepOutSnap(!keepOutSnap))}
        </>
      );
      break;
    case "pan":
      content = (
        <>
          {label(Hand, t("panel.tool.pan"))}
          {divider}
          {hint(t("panel.toolbar.panHint"))}
        </>
      );
      break;
    case "select":
    default:
      content = (
        <>
          {label(MousePointer2, t("panel.tool.select"))}
          {divider}
          {hint(t("panel.toolbar.selectHint"))}
        </>
      );
      break;
  }

  return (
    <div
      className="absolute left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-2.5 rounded-lg border border-border bg-card/90 px-2.5 py-1.5 shadow-lg backdrop-blur"
      style={{ top: RULER_TOP + RULER_OVERLAY_GAP }}
    >
      {content}
    </div>
  );
}
