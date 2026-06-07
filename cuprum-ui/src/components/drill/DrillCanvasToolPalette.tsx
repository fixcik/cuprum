import { MousePointer2, Hand } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { rulerCornerOffset } from "@/components/editor/canvasStyle";

export interface DrillCanvasToolPaletteProps {
  tool: "select" | "pan";
  onToolChange: (t: "select" | "pan") => void;
}

function ToolButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-md transition-colors",
        active
          ? "border border-primary/40 bg-primary/10 text-primary"
          : "border border-transparent text-muted-foreground hover:bg-muted/70 hover:text-foreground",
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

/** Floating left-side tool palette for the drill canvas: select and pan tools. */
export function DrillCanvasToolPalette({ tool, onToolChange }: DrillCanvasToolPaletteProps) {
  const { t } = useTranslation("drill");

  return (
    <div
      className="absolute flex flex-col gap-0.5 rounded-lg border border-border bg-card/90 p-1 shadow backdrop-blur"
      // Tucked into the canvas corner, clear of both ruler bands
      style={rulerCornerOffset()}
    >
      <ToolButton
        icon={MousePointer2}
        label={t("tool.select")}
        active={tool === "select"}
        onClick={() => onToolChange("select")}
      />
      <ToolButton
        icon={Hand}
        label={t("tool.pan")}
        active={tool === "pan"}
        onClick={() => onToolChange("pan")}
      />
    </div>
  );
}
