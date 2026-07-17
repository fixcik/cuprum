import { useTranslation } from "react-i18next";
import { MousePointer2, Hand, FilePlus2, Target, Crosshair, OctagonAlert, Ruler, type LucideIcon } from "lucide-react";
import { rulerCornerOffset } from "@/components/editor/canvasStyle";
import { api } from "@/lib/api";

export type PanelTool = "select" | "pan" | "tooling" | "alignpoint" | "keepout" | "measure";

/** Per-tool keyboard shortcut, surfaced in the button title (e.g. "Выбор · V").
 *  The shortcuts themselves are bound in PanelEditor's global keydown. */
const TOOL_SHORTCUT: Record<PanelTool, string> = {
  select: "V",
  pan: "H",
  tooling: "T",
  alignpoint: "C",
  keepout: "K",
  measure: "M",
};

/** Floating tool palette over the panel canvas (KiCad/Photoshop style). The rail
 *  holds only the modal tools plus a single "add design" command at the top — the
 *  set never swaps. Tool options (hole mode, diameter, snap, …) live in the
 *  horizontal ToolOptionsBar at the top of the canvas; selection actions
 *  (duplicate/delete/rotate/open) live in SelectionHud, the context menu and
 *  keyboard shortcuts. Neither is mirrored here. */
export function PanelToolPalette({
  tool,
  onToolChange,
}: {
  tool: PanelTool;
  onToolChange: (t: PanelTool) => void;
}) {
  const { t } = useTranslation("project");

  const toolBtn = (id: PanelTool, Icon: LucideIcon, label: string) => {
    const active = tool === id;
    const title = `${label} · ${TOOL_SHORTCUT[id]}`;
    return (
      <button
        type="button"
        onClick={() => onToolChange(id)}
        aria-label={title}
        title={title}
        aria-pressed={active}
        className={[
          "grid size-9 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          active ? "bg-primary/20 text-primary" : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        ].join(" ")}
      >
        <Icon className="size-[18px]" />
      </button>
    );
  };

  const divider = <div className="my-0.5 h-px w-6 bg-border" />;

  return (
    <div
      className="absolute z-10 flex flex-col items-center gap-1 rounded-lg border border-border bg-card/90 p-1.5 shadow-lg backdrop-blur"
      style={rulerCornerOffset()}
    >
      {/* Primary command: opens a separate window, not a modal tool. */}
      <button
        type="button"
        onClick={() => void api.openAddDesignWindow()}
        aria-label={t("panel.tool.add")}
        title={t("panel.tool.add")}
        className="grid size-9 place-items-center rounded-md text-primary transition-colors hover:bg-primary/15 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <FilePlus2 className="size-[18px]" />
      </button>
      {divider}
      {toolBtn("select", MousePointer2, t("panel.tool.select"))}
      {toolBtn("pan", Hand, t("panel.tool.pan"))}
      {divider}
      {toolBtn("tooling", Target, t("panel.tool.tooling"))}
      {toolBtn("alignpoint", Crosshair, t("panel.tool.alignpoint"))}
      {toolBtn("keepout", OctagonAlert, t("panel.tool.keepout"))}
      {divider}
      {toolBtn("measure", Ruler, t("panel.tool.measure"))}
    </div>
  );
}
