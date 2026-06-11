import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Layers, Loader2 } from "lucide-react";
import { api, type PanelDoc, type ProjectDesign } from "@/lib/api";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { useDesignVerdict } from "@/hooks/useDesignVerdict";
import { VerdictDot } from "@/components/ui/VerdictDot";

/** One selectable design row in the add-design window list. */
export function DesignPickerRow({
  design,
  workingDir,
  panel,
  selected,
  onSelect,
}: {
  design: ProjectDesign;
  workingDir: string;
  panel: { widthMm: number; heightMm: number };
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("project");
  const { fmtLen } = useUnitFormat();
  const profile = useSettings((s) => s.profile);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewSettled, setPreviewSettled] = useState(false);

  const gerbersKey = useMemo(
    () => design.gerbers.map((g) => `${g.path}:${g.layer_type}`).join(","),
    [design],
  );

  // Minimal PanelDoc so the verdict's size check runs against this panel. Never
  // persisted — only fed to the client-side feasibility check.
  const panelDoc = useMemo<PanelDoc>(
    () => ({
      schema_version: 3,
      width_mm: panel.widthMm,
      height_mm: panel.heightMm,
      origin_x_mm: 0,
      origin_y_mm: 0,
      instances: [],
      tooling_holes: [],
      keep_out_zones: [],
      drill_class_overrides: {},
    }),
    [panel.widthMm, panel.heightMm],
  );
  const { verdict, size } = useDesignVerdict(workingDir, design.gerbers, profile, { panel: panelDoc });

  useEffect(() => {
    let cancelled = false;
    setPreviewSettled(false);
    // Include drill: the backend punches it as transparent holes (not a drawn
    // layer) and hashes it into the preview key, which must match the pack-gc
    // valid set in workdir.rs.
    const gerbers = design.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type }));
    // Nothing renderable (drill-only / empty) — settle so we show a neutral
    // placeholder instead of a spinner that would never stop.
    if (gerbers.every((g) => g.layerType === "drill")) {
      setPreviewSettled(true);
      return;
    }
    api
      .renderDesignPreview(workingDir, design.id, gerbers)
      .then((r) => {
        if (!cancelled) {
          setPreviewUrl(r.pngDataUrl);
          setPreviewSettled(true);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPreviewUrl(null);
          setPreviewSettled(true);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, gerbersKey]);

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={[
          "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
          selected ? "bg-primary/10" : "hover:bg-foreground/5",
        ].join(" ")}
      >
        <div
          className={[
            "relative size-[46px] shrink-0 overflow-hidden rounded-md border bg-muted/30",
            selected ? "border-primary/60" : "border-border",
          ].join(" ")}
        >
          {previewUrl ? (
            <img src={previewUrl} alt={design.source_name} className="h-full w-full object-contain p-0.5" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              {previewSettled ? (
                <Layers className="size-4 text-muted-foreground/40" />
              ) : (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              )}
            </div>
          )}
          {verdict && <VerdictDot verdict={verdict} className="absolute right-1 top-1 size-2 ring-2 ring-card" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`truncate text-[12px] font-medium ${selected ? "text-primary" : "text-foreground"}`}>
            {design.source_name}
          </div>
          <div className="truncate text-[11px] tabular-nums text-muted-foreground">
            {t("designs.layerCount", { count: design.gerbers.length })}
            {size ? ` · ${fmtLen(size.w)} × ${fmtLen(size.h)}` : ""}
          </div>
        </div>
      </button>
    </li>
  );
}
