import { useTranslation } from "react-i18next";
import { MousePointer2, Hand, FilePlus2, Copy, Trash2, type LucideIcon } from "lucide-react";
import { api } from "@/lib/api";
import { useShell } from "@/shellStore";
import { usePanelSelection } from "@/panelSelectionStore";

export type PanelTool = "select" | "pan";

/** Floating tool palette over the panel canvas (KiCad/Photoshop style). Add is
 *  always available; delete acts on the current selection (duplicate lands later). */
export function PanelToolPalette({
  tool,
  onToolChange,
}: {
  tool: PanelTool;
  onToolChange: (t: PanelTool) => void;
}) {
  const { t } = useTranslation("project");
  const selected = usePanelSelection((s) => s.selected);
  const removeInstances = useShell((s) => s.removeInstances);
  const selectedCount = selected.size;
  const deleteSelected = () => {
    if (selectedCount === 0) return;
    void removeInstances([...selected]);
    usePanelSelection.getState().clear();
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

  const actionBtn = (Icon: LucideIcon, label: string, onClick?: () => void, disabled = false) => (
    <button
      type="button"
      onClick={onClick}
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
    <div className="absolute left-3 top-3 z-10 flex flex-col items-center gap-1 rounded-lg border border-border bg-card/90 p-1.5 shadow-lg backdrop-blur">
      {toolBtn("select", MousePointer2, t("panel.tool.select"))}
      {toolBtn("pan", Hand, t("panel.tool.pan"))}
      <div className="my-0.5 h-px w-6 bg-border" />
      {actionBtn(FilePlus2, t("panel.tool.add"), () => void api.openAddDesignWindow())}
      {actionBtn(Copy, t("panel.tool.duplicate"), undefined, true)}
      {actionBtn(Trash2, t("panel.tool.delete"), deleteSelected, selectedCount === 0)}
    </div>
  );
}
