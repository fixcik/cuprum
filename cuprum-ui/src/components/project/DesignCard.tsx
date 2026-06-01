import { useEffect, useMemo, useState } from "react";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { LayerStack, type StackLayer } from "@/components/import/LayerStack";
import { colorFor, sideOf, missingRequired } from "@/lib/layerColors";
import { api, type ProjectDesign } from "@/lib/api";
import { evaluate, overallVerdict, type Verdict } from "@/lib/feasibility";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";

export function DesignCard({
  design,
  onOpen,
  onDelete,
}: {
  design: ProjectDesign;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation(["project", "layers"]);
  const workingDir = useShell((s) => s.workingDir);
  const layerColors = useShell((s) => s.currentManifest?.layer_colors);
  const panel = useShell((s) => s.currentManifest?.panel ?? null);
  const profile = useSettings((s) => s.profile);
  const [layers, setLayers] = useState<StackLayer[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const { fmtLen } = useUnitFormat();

  // Content-based key (path + type per gerber). Effects depend on this string, not
  // the `design` object, so an unrelated manifest replace (which hands every card
  // a fresh `design` reference) does not re-fetch this card's SVGs/metrics.
  const gerbersKey = useMemo(
    () => design.gerbers.map((g) => `${g.path}:${g.layer_type}`).join(","),
    [design],
  );

  // 2D thumbnail: render each non-drill gerber's SVG once (top side only — a card
  // is a glance, not the inspector). Reuse the same progressive pattern as the
  // inspector but without holes/3D.
  useEffect(() => {
    let cancelled = false;
    if (!workingDir) return;
    const gs = design.gerbers.filter((g) => g.layer_type !== "drill");
    const slots: (StackLayer | null)[] = gs.map(() => null);
    setLayers([]);
    gs.forEach((g, i) => {
      api
        .renderGerberSvg(workingDir, g.path)
        .then((geo) => {
          if (cancelled) return;
          slots[i] = {
            key: g.path,
            svgBody: geo.svgBody,
            bbox: geo.bbox,
            color: colorFor(g.layer_type, layerColors),
            visible: sideOf(g.layer_type) !== "bottom",
            type: g.layer_type,
            snap: geo.snap,
          };
          setLayers(slots.filter(Boolean) as StackLayer[]);
        })
        .catch(() => {});
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gerbersKey stands in for `design`
  }, [workingDir, gerbersKey, layerColors]);

  // Board size + DFM verdict badge (lazy, cached on disk). Metrics give the real
  // board extent, so the size chip shows even for an incomplete design; the verdict
  // dot, however, stays null until the required layers (outline + copper) are present.
  useEffect(() => {
    let cancelled = false;
    if (!workingDir) return;
    const hasRequired =
      missingRequired(design.gerbers.map((g) => g.layer_type)).length === 0;
    api
      .projectBoardMetrics(
        workingDir,
        design.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
      )
      .then((m) => {
        if (cancelled) return;
        setSize({ w: m.board.widthMm, h: m.board.heightMm });
        setVerdict(hasRequired ? overallVerdict(evaluate(m, profile, panel)) : null);
      })
      .catch(() => {
        if (cancelled) return;
        setSize(null);
        setVerdict(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gerbersKey stands in for `design`
  }, [workingDir, gerbersKey, profile, panel]);

  const dotClass =
    verdict === "block"
      ? "bg-destructive"
      : verdict === "warn"
        ? "bg-warning"
        : verdict === "ok"
          ? "bg-success"
          : "bg-muted-foreground/40";

  return (
    <div className="group relative">
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-primary/50"
      >
        <div className="relative aspect-[4/3] w-full bg-muted/30">
          {layers.length > 0 && <LayerStack layers={layers} side="top" chrome={false} />}
          <span className={`absolute right-2 top-2 size-2.5 rounded-full ${dotClass}`} aria-hidden />
        </div>
        <div className="flex items-end justify-between gap-2 p-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="truncate text-[13px] font-medium text-foreground">{design.source_name}</div>
            <div className="text-[11px] text-muted-foreground">
              {t("designs.layerCount", { count: design.gerbers.length })}
            </div>
          </div>
          {size && (
            <div className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
              {fmtLen(size.w)} × {fmtLen(size.h)}
            </div>
          )}
        </div>
      </button>
      {/* Delete is a sibling overlay (not nested in the card button — that'd be
          invalid HTML). Removal is undoable, so no confirm dialog. */}
      <button
        type="button"
        onClick={onDelete}
        aria-label={t("designs.delete")}
        title={t("designs.delete")}
        className="absolute left-2 top-2 cursor-pointer rounded-md bg-card/90 p-1 text-muted-foreground opacity-0 shadow-sm transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}
