import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { LayerStack, type StackLayer } from "@/components/import/LayerStack";
import { colorFor, sideOf, missingRequired } from "@/lib/layerColors";
import { api, type ProjectDesign } from "@/lib/api";
import { evaluate, overallVerdict, type Verdict } from "@/lib/feasibility";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";

export function DesignCard({ design, onOpen }: { design: ProjectDesign; onOpen: () => void }) {
  const { t } = useTranslation(["project", "layers"]);
  const workingDir = useShell((s) => s.workingDir);
  const layerColors = useShell((s) => s.currentManifest?.layer_colors);
  const panel = useShell((s) => s.currentManifest?.panel ?? null);
  const profile = useSettings((s) => s.profile);
  const [layers, setLayers] = useState<StackLayer[]>([]);
  const [verdict, setVerdict] = useState<Verdict | null>(null);

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

  // DFM verdict badge (lazy, cached on disk). Skipped until the outline is assigned.
  useEffect(() => {
    let cancelled = false;
    if (!workingDir) return;
    if (missingRequired(design.gerbers.map((g) => g.layer_type)).length > 0) {
      setVerdict(null);
      return;
    }
    api
      .projectBoardMetrics(
        workingDir,
        design.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type })),
      )
      .then((m) => {
        if (!cancelled) setVerdict(overallVerdict(evaluate(m, profile, panel)));
      })
      .catch(() => {
        if (!cancelled) setVerdict(null);
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
    <button
      type="button"
      onClick={onOpen}
      className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-primary/50"
    >
      <div className="relative aspect-[4/3] w-full bg-muted/30">
        {layers.length > 0 && <LayerStack layers={layers} side="top" chrome={false} />}
        <span className={`absolute right-2 top-2 size-2.5 rounded-full ${dotClass}`} aria-hidden />
      </div>
      <div className="flex flex-col gap-0.5 p-3">
        <div className="truncate text-[13px] font-medium text-foreground">{design.source_name}</div>
        <div className="text-[11px] text-muted-foreground">
          {t("designs.layerCount", { count: design.gerbers.length })}
        </div>
      </div>
    </button>
  );
}
