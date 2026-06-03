import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Layers, Loader2 } from "lucide-react";
import { api, type PanelDoc, type ProjectDesign } from "@/lib/api";
import { evaluate, overallVerdict, type Verdict } from "@/lib/feasibility";
import { missingRequired } from "@/lib/layerColors";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";

const DOT: Record<Verdict, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  block: "bg-destructive",
};

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
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);

  const gerbersKey = useMemo(
    () => design.gerbers.map((g) => `${g.path}:${g.layer_type}`).join(","),
    [design],
  );

  useEffect(() => {
    let cancelled = false;
    setPreviewSettled(false);
    const gerbers = design.gerbers
      .filter((g) => g.layer_type !== "drill")
      .map((g) => ({ rel: g.path, layerType: g.layer_type }));
    // Nothing renderable (drill-only / empty) — settle so we show a neutral
    // placeholder instead of a spinner that would never stop.
    if (gerbers.length === 0) {
      setPreviewSettled(true);
      return;
    }
    api
      .renderDesignPreview(workingDir, design.id, gerbers, undefined, undefined)
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

  useEffect(() => {
    let cancelled = false;
    const hasRequired = missingRequired(design.gerbers.map((g) => g.layer_type)).length === 0;
    // Build a minimal PanelDoc so evaluate() can check board fit against the panel.
    const panelDoc: PanelDoc = {
      schema_version: 1,
      width_mm: panel.widthMm,
      height_mm: panel.heightMm,
      origin_x_mm: 0,
      origin_y_mm: 0,
      instances: [],
      tooling_holes: [],
    };
    api
      .projectBoardMetrics(
        workingDir,
        design.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
      )
      .then((m) => {
        if (cancelled) return;
        setSize({ w: m.metrics.board.widthMm, h: m.metrics.board.heightMm });
        setVerdict(hasRequired ? overallVerdict(evaluate(m.metrics, profile, panelDoc)) : null);
      })
      .catch(() => {
        if (!cancelled) {
          setSize(null);
          setVerdict(null);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workingDir, gerbersKey, profile, panel.widthMm, panel.heightMm]);

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
          {verdict && (
            <span className={`absolute right-1 top-1 size-2 rounded-full ${DOT[verdict]} ring-2 ring-card`} />
          )}
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
