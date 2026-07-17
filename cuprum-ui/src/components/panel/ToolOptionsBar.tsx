import { useTranslation } from "react-i18next";
import { MousePointer2, Hand, Target, OctagonAlert, Ruler, CircleDot, Grid2x2, Crosshair, Magnet, Trash2, type LucideIcon } from "lucide-react";
import { RULER_TOP, RULER_OVERLAY_GAP } from "@/components/editor/canvasStyle";
import { UnitField } from "@/components/ui/settings/UnitField";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { usePanelTool } from "@/panelToolStore";
import { useSettings, type Units } from "@/settingsStore";
import type { PanelTool } from "@/components/panel/PanelToolPalette";
import type { ToolingHole, ToolingHoleRole } from "@/lib/api";

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
  selectedHole,
  onHoleDiameter,
  onHoleRole,
  onHoleDelete,
}: {
  tool: PanelTool;
  onAddHole: () => void;
  addArmed: boolean;
  onAddRegistrationSet: () => void;
  onAddAutoFiducials: () => void;
  /** When a tooling hole is selected, the bar shows ITS properties (diameter, role,
   *  delete) instead of the tool options — one bar, no separate inspector. */
  selectedHole: ToolingHole | null;
  onHoleDiameter: (mm: number) => void;
  onHoleRole: (r: ToolingHoleRole) => void;
  onHoleDelete: () => void;
}) {
  const { t } = useTranslation(["project", "common"]);
  const holeDiameterMm = usePanelTool((s) => s.holeDiameterMm);
  const setHoleDiameterMm = usePanelTool((s) => s.setHoleDiameterMm);
  const keepOutSnap = usePanelTool((s) => s.keepOutSnap);
  const setKeepOutSnap = usePanelTool((s) => s.setKeepOutSnap);
  // The measure readout follows the global display units (settingsStore.units),
  // so the segment both reflects and drives the same setting useUnitFormat reads.
  const units = useSettings((s) => s.units);
  const setUnits = useSettings((s) => s.setUnits);

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
  if (selectedHole) {
    // A hole is selected (in tooling or select) — show its properties here instead
    // of the tool options, so there is a single bar, not a duplicate inspector.
    content = (
      <>
        {label(Target, t("panel.tool.tooling"))}
        {divider}
        <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          Ø
          <UnitField value={selectedHole.diameter_mm} onChange={onHoleDiameter} dim="fine" className="w-20" />
        </span>
        {divider}
        <SegmentedControl<ToolingHoleRole>
          value={selectedHole.role}
          onChange={onHoleRole}
          options={[
            { value: "registration", label: t("panel.tooling.role.registration") },
            { value: "flip", label: t("panel.tooling.role.flip") },
            { value: "unused", label: t("panel.tooling.role.unused") },
          ]}
        />
        {divider}
        <button
          type="button"
          onClick={onHoleDelete}
          aria-label={t("panel.tooling.delete")}
          title={t("panel.tooling.delete")}
          className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Trash2 className="size-4" />
        </button>
      </>
    );
  } else switch (tool) {
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
    case "alignpoint":
      // The active-tool banner: label + placement/snap hint, centred at the top
      // of the canvas (this bar already clears the rulers and the tool palette).
      content = (
        <>
          {label(Crosshair, t("panel.tool.alignpoint"))}
          {divider}
          {hint(t("panel.toolbar.alignHint"))}
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
    case "measure":
      content = (
        <>
          {label(Ruler, t("panel.tool.measure"))}
          {divider}
          <SegmentedControl<Units>
            value={units}
            onChange={setUnits}
            options={[
              { value: "mm", label: t("common:unit.mm") },
              { value: "imperial", label: t("common:unit.inch") },
            ]}
          />
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
