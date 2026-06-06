import { useTranslation } from "react-i18next";
import type { DrillClass } from "@/lib/api";
import type { DrillPass } from "@/lib/drillPasses";
import { CLASS_COLORS } from "@/components/drill/DrillCanvasTopBar";

export interface DrillPassStepperProps {
  activePassId: DrillPass["id"];
  counts: Record<DrillClass, number>;
  /** Block pass clicks while a run is in progress. */
  disabled?: boolean;
  onPassChange: (id: DrillPass["id"]) => void;
}

/** Vertical 5-node process stepper: 3 clickable pass nodes + 2 fixed off-machine steps.
 *  Clicking a pass node switches the active pass (and therefore the selected class set).
 *  Off-machine nodes are non-interactive visual separators. */
export function DrillPassStepper({
  activePassId,
  counts,
  disabled,
  onPassChange,
}: DrillPassStepperProps) {
  const { t } = useTranslation("drill");

  // Ordered list of stepper nodes.
  type PassNode = {
    kind: "pass";
    id: DrillPass["id"];
    label: string;
    dotColor: string;
    count: number;
  };
  type OffNode = {
    kind: "off";
    label: string;
    sub: string;
    variant: "dashed" | "amber";
  };
  type Node = PassNode | OffNode;

  const nodes: Node[] = [
    {
      kind: "pass",
      id: "alignment",
      label: t("pass.alignment"),
      dotColor: CLASS_COLORS.registration,
      count: counts.registration,
    },
    {
      kind: "pass",
      id: "preplating",
      label: t("pass.preplating"),
      dotColor: CLASS_COLORS.pth,
      count: counts.pth,
    },
    {
      kind: "off",
      label: t("step.plating"),
      sub: t("step.platingSub"),
      variant: "dashed",
    },
    {
      kind: "off",
      label: t("step.flip"),
      sub: t("step.flipSub"),
      variant: "amber",
    },
    {
      kind: "pass",
      id: "postplating",
      label: t("pass.postplating"),
      dotColor: CLASS_COLORS.npth,
      count: counts.npth + counts.mechanical,
    },
  ];

  return (
    <div className="relative flex flex-col px-4 py-3">
      {/* Vertical connector line behind nodes */}
      <div className="absolute left-[27px] top-6 bottom-6 w-px bg-border" aria-hidden />

      <ul className="flex flex-col gap-1">
        {nodes.map((node, i) => {
          if (node.kind === "pass") {
            const isActive = node.id === activePassId;
            return (
              <li key={node.id}>
                <button
                  type="button"
                  disabled={!!disabled}
                  onClick={() => !disabled && onPassChange(node.id)}
                  className={
                    "relative z-10 flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors " +
                    (isActive
                      ? "border-primary/30 bg-primary/15 text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-muted/40 hover:text-foreground " +
                        (disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer"))
                  }
                >
                  {/* Node circle */}
                  <span
                    className={
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-[10px] font-bold " +
                      (isActive
                        ? "border-primary bg-primary/20 text-primary"
                        : "border-border bg-background text-muted-foreground")
                    }
                  >
                    {i + 1}
                  </span>

                  {/* Label */}
                  <span className="flex-1 font-medium">{node.label}</span>

                  {/* Colour dot + count */}
                  <span className="flex items-center gap-1.5 text-xs tabular-nums">
                    <span
                      className="h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: node.dotColor }}
                    />
                    <span className={isActive ? "text-foreground" : "text-muted-foreground"}>
                      {node.count}
                    </span>
                  </span>
                </button>
              </li>
            );
          }

          // Off-machine node (non-interactive)
          return (
            <li key={`off-${i}`} className="relative z-10 flex items-center gap-3 px-3 py-2">
              {/* Node circle */}
              <span
                className={
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 text-[10px] " +
                  (node.variant === "amber"
                    ? "border-amber-500/50 bg-background text-amber-500"
                    : "border-dashed border-border bg-background text-muted-foreground")
                }
              >
                {i + 1}
              </span>

              {/* Label + sub */}
              <div className="flex flex-col">
                <span
                  className={
                    "text-sm " +
                    (node.variant === "amber"
                      ? "text-amber-400/70"
                      : "text-muted-foreground/70")
                  }
                >
                  {node.label}
                </span>
                <span
                  className={
                    "text-[11px] " +
                    (node.variant === "amber"
                      ? "text-amber-500/50"
                      : "text-muted-foreground/50")
                  }
                >
                  {node.sub}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
