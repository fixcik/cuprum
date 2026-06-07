import { useTranslation } from "react-i18next";
import { MousePointer2, Hand, FilePlus2, Copy, Trash2, Target, Grid2x2, CirclePlus, OctagonAlert, type LucideIcon } from "lucide-react";
import { rulerCornerOffset } from "@/components/editor/canvasStyle";
import { api } from "@/lib/api";
import { useShell } from "@/shellStore";
import { usePanelSelection } from "@/panelSelectionStore";
import { useKeepOutSelection } from "@/keepOutSelectionStore";

export type PanelTool = "select" | "pan" | "tooling" | "keepout";

/** Floating tool palette over the panel canvas (KiCad/Photoshop style). Add is
 *  always available; duplicate and delete act on the current selection. The
 *  duplicate action is delegated to `onDuplicate` so the caller can apply a
 *  clamped offset before dispatching to the store. When tool is "tooling", an
 *  extra action button to add a registration set is shown. */
export function PanelToolPalette({
  tool,
  onToolChange,
  onDuplicate,
  onAddHole,
  addArmed,
  onAddRegistrationSet,
}: {
  tool: PanelTool;
  onToolChange: (t: PanelTool) => void;
  onDuplicate: () => void;
  onAddHole: () => void;
  addArmed: boolean;
  onAddRegistrationSet: () => void;
}) {
  const { t } = useTranslation("project");
  const selected = usePanelSelection((s) => s.selected);
  const keepOutSelected = useKeepOutSelection((s) => s.selected);
  const removeInstances = useShell((s) => s.removeInstances);
  const removeKeepOutZones = useShell((s) => s.removeKeepOutZones);
  const selectedCount = selected.size;
  const keepOutSelectedCount = keepOutSelected.size;
  const deleteSelected = () => {
    if (selectedCount === 0 && keepOutSelectedCount === 0) return;
    if (selectedCount > 0) {
      void removeInstances([...selected]);
      usePanelSelection.getState().clear();
    }
    if (keepOutSelectedCount > 0) {
      void removeKeepOutZones([...keepOutSelected]);
      useKeepOutSelection.getState().clear();
    }
  };

  const toolBtn = (id: PanelTool, Icon: LucideIcon, label: string) => {
    const active = tool === id;
    return (
      <button
        type="button"
        onClick={() => onToolChange(id)}
        aria-label={label}
        title={label}
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

  const actionBtn = (Icon: LucideIcon, label: string, onClick?: () => void, disabled = false, active = false) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active}
      className={[
        "grid size-9 place-items-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        disabled
          ? "cursor-not-allowed text-muted-foreground/30"
          : active
            ? "bg-primary/20 text-primary"
            : "text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
      ].join(" ")}
    >
      <Icon className="size-[18px]" />
    </button>
  );

  return (
    <div
      className="absolute z-10 flex flex-col items-center gap-1 rounded-lg border border-border bg-card/90 p-1.5 shadow-lg backdrop-blur"
      style={rulerCornerOffset()}
    >
      {toolBtn("select", MousePointer2, t("panel.tool.select"))}
      {toolBtn("pan", Hand, t("panel.tool.pan"))}
      {toolBtn("tooling", Target, t("panel.tool.tooling"))}
      {toolBtn("keepout", OctagonAlert, t("panel.tool.keepout"))}
      <div className="my-0.5 h-px w-6 bg-border" />
      {tool === "tooling" ? (
        <>
          {actionBtn(CirclePlus, t("panel.tool.addHole"), onAddHole, false, addArmed)}
          {actionBtn(Grid2x2, t("panel.tool.registrationSet"), onAddRegistrationSet)}
        </>
      ) : tool === "keepout" ? null : (
        <>
          {actionBtn(FilePlus2, t("panel.tool.add"), () => void api.openAddDesignWindow())}
          {actionBtn(Copy, t("panel.tool.duplicate"), selectedCount === 0 ? undefined : onDuplicate, selectedCount === 0)}
          {actionBtn(Trash2, t("panel.tool.delete"), deleteSelected, selectedCount === 0 && keepOutSelectedCount === 0)}
        </>
      )}
    </div>
  );
}
