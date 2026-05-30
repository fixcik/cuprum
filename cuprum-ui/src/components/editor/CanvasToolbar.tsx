import type { ComponentType } from "react";
import {
  MousePointer2,
  Hand,
  FilePlus2,
  Copy,
  Trash2,
  AlignHorizontalJustifyStart,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignVerticalJustifyStart,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignHorizontalDistributeCenter,
  AlignVerticalDistributeCenter,
} from "lucide-react";
import { useStore } from "@/store";
import { cn } from "@/lib/utils";

function Tool({
  icon: Icon,
  title,
  onClick,
  disabled,
  active,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-md transition-colors",
        active
          ? "bg-primary/20 text-primary"
          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-30",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

const Divider = () => <div className="my-0.5 h-px w-6 self-center bg-border" />;

/** Floating tool palette over the preview (Photoshop-style). Alignment tools
 *  appear once 2+ placements are selected. */
export function CanvasToolbar() {
  const s = useStore();
  const n = s.selectedIds.length;

  return (
    <div className="absolute left-2 top-2 flex flex-col gap-0.5 rounded-lg border border-border bg-card/90 p-1 shadow-lg backdrop-blur">
      <Tool
        icon={MousePointer2}
        title="Select / marquee (V)"
        onClick={() => s.setTool("select")}
        active={s.tool === "select"}
      />
      <Tool
        icon={Hand}
        title="Pan (H · or hold Space)"
        onClick={() => s.setTool("pan")}
        active={s.tool === "pan"}
      />
      <Divider />
      <Tool icon={FilePlus2} title="Add Gerber" onClick={s.addGerber} />
      <Tool icon={Copy} title="Duplicate (⌘D)" onClick={s.duplicateSelected} disabled={n === 0} />
      <Tool icon={Trash2} title="Delete (⌫)" onClick={s.removeSelected} disabled={n === 0} />

      {n >= 2 && (
        <>
          <Divider />
          <Tool icon={AlignHorizontalJustifyStart} title="Align left" onClick={() => s.alignSelected("left")} />
          <Tool icon={AlignHorizontalJustifyCenter} title="Align center X" onClick={() => s.alignSelected("hcenter")} />
          <Tool icon={AlignHorizontalJustifyEnd} title="Align right" onClick={() => s.alignSelected("right")} />
          <Tool icon={AlignVerticalJustifyStart} title="Align top" onClick={() => s.alignSelected("top")} />
          <Tool icon={AlignVerticalJustifyCenter} title="Align middle Y" onClick={() => s.alignSelected("vmiddle")} />
          <Tool icon={AlignVerticalJustifyEnd} title="Align bottom" onClick={() => s.alignSelected("bottom")} />
          <Divider />
          <Tool
            icon={AlignHorizontalDistributeCenter}
            title="Distribute horizontally"
            onClick={() => s.distributeSelected("h")}
            disabled={n < 3}
          />
          <Tool
            icon={AlignVerticalDistributeCenter}
            title="Distribute vertically"
            onClick={() => s.distributeSelected("v")}
            disabled={n < 3}
          />
        </>
      )}
    </div>
  );
}
