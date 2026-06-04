import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { UnitField } from "@/components/ui/settings/UnitField";
import type { ToolingHole, ToolingHoleRole } from "@/lib/api";

/** Floating DOM inspector for a selected tooling hole. Positioned absolute by
 *  the parent (bottom-centre of the canvas). Shows diameter input, role selector,
 *  and delete button. */
export function ToolingHoleInspector({
  hole,
  onDiameter,
  onRole,
  onDelete,
}: {
  hole: ToolingHole;
  onDiameter: (mm: number) => void;
  onRole: (r: ToolingHoleRole) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("project");

  return (
    <div className="absolute bottom-2 left-1/2 z-10 -translate-x-1/2">
      <div className="flex items-center gap-2 rounded-md border border-border bg-card/90 px-2 py-1.5 shadow-lg backdrop-blur">
        <span className="text-[11px] text-muted-foreground">
          {t("panel.tooling.diameter")}
        </span>
        <UnitField
          value={hole.diameter_mm}
          onChange={onDiameter}
          dim="fine"
          className="w-24"
        />

        <div className="h-5 w-px bg-border" />

        <SegmentedControl<ToolingHoleRole>
          value={hole.role}
          onChange={onRole}
          options={[
            { value: "registration", label: t("panel.tooling.role.registration") },
            { value: "flip", label: t("panel.tooling.role.flip") },
            { value: "unused", label: t("panel.tooling.role.unused") },
          ]}
        />

        <div className="h-5 w-px bg-border" />

        <button
          type="button"
          onClick={onDelete}
          aria-label={t("panel.tooling.delete")}
          title={t("panel.tooling.delete")}
          className="grid size-7 cursor-pointer place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </div>
  );
}
