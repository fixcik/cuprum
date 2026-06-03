import { useEffect, useMemo, useRef, useState } from "react";
import { Settings, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { missingRequired } from "@/lib/layerColors";
import { api, type ProjectDesign } from "@/lib/api";
import { evaluate, overallVerdict, type Verdict } from "@/lib/feasibility";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { RenameDesignModal } from "@/components/project/RenameDesignModal";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { ringFraction } from "@/lib/artifactProgress";

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
  const stackup = useShell((s) => s.currentManifest?.stackup ?? null);
  const scheduleArtifactFlush = useShell((s) => s.scheduleArtifactFlush);
  const reportArtifactProgress = useShell((s) => s.reportArtifactProgress);
  const clearArtifactProgress = useShell((s) => s.clearArtifactProgress);
  // Opaque trace-session token set at import time; undefined for disk-opened designs.
  const traceSession = useShell((s) => s.traceSessions[design.id]);
  const profile = useSettings((s) => s.profile);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [svgReady, setSvgReady] = useState(false);
  const [metricsReady, setMetricsReady] = useState(false);
  const { fmtLen } = useUnitFormat();

  // Content-based key (path + type per gerber). Effects depend on this string, not
  // the `design` object, so an unrelated manifest replace (which hands every card
  // a fresh `design` reference) does not re-fetch this card's SVGs/metrics.
  const gerbersKey = useMemo(
    () => design.gerbers.map((g) => `${g.path}:${g.layer_type}`).join(","),
    [design],
  );

  // Card thumbnail: one backend-composited preview PNG (cached in the project),
  // not a live multi-layer SVG — a grid of full SVG stacks is what bogs the
  // frontend down at scale.
  useEffect(() => {
    let cancelled = false;
    if (!workingDir) return;
    const gerbers = design.gerbers
      .filter((g) => g.layer_type !== "drill")
      .map((g) => ({ rel: g.path, layerType: g.layer_type }));
    if (gerbers.length === 0) {
      setPreviewUrl(null);
      return;
    }
    setPreviewUrl(null);
    api
      .renderDesignPreview(workingDir, design.id, gerbers, layerColors ?? undefined, traceSession)
      .then((r) => {
        if (!cancelled) {
          setPreviewUrl(r.pngDataUrl);
          scheduleArtifactFlush(r.fresh);
        }
      })
      .catch(() => {
        if (!cancelled) setPreviewUrl(null);
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
        traceSession,
      )
      .then((m) => {
        if (cancelled) return;
        setSize({ w: m.metrics.board.widthMm, h: m.metrics.board.heightMm });
        setVerdict(hasRequired ? overallVerdict(evaluate(m.metrics, profile, panel, stackup)) : null);
        scheduleArtifactFlush(m.fresh);
        setMetricsReady(true);
      })
      .catch(() => {
        if (cancelled) return;
        setSize(null);
        setVerdict(null);
        setMetricsReady(true); // settled-on-error so the ring completes
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gerbersKey stands in for `design`
  }, [workingDir, gerbersKey, profile, panel, stackup]);

  // Precompute per-layer SVG so it ships in the .cuprum and the inspector opens
  // instantly — even though the card itself shows only the composite preview.
  useEffect(() => {
    let cancelled = false;
    if (!workingDir) return;
    const rels = design.gerbers.filter((g) => g.layer_type !== "drill").map((g) => g.path);
    if (rels.length === 0) {
      setSvgReady(true);
      return;
    }
    setSvgReady(false);
    api
      .renderLayersSvg(workingDir, rels, traceSession)
      .then((results) => {
        if (cancelled) return;
        setSvgReady(true);
        scheduleArtifactFlush(results.some((r) => r.fresh));
      })
      .catch(() => {
        if (!cancelled) setSvgReady(true); // settled-on-error so the ring completes
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- gerbersKey stands in for `design`
  }, [workingDir, gerbersKey]);

  const fraction = ringFraction({ svg: svgReady, preview: previewUrl != null, metrics: metricsReady });

  useEffect(() => {
    reportArtifactProgress(design.id, fraction);
  }, [design.id, fraction, reportArtifactProgress]);

  // Latest fraction for the unmount cleanup (kept in a ref so the cleanup runs
  // only on unmount / design switch, not on every fraction change).
  const fractionRef = useRef(fraction);
  fractionRef.current = fraction;
  useEffect(() => {
    return () => {
      // Card unmounted (e.g. tab switch) while still preparing → drop its entry
      // so the global chip doesn't freeze at a partial fraction. A finished
      // entry (==1) stays, so returning to the gallery doesn't re-flash the chip.
      if (fractionRef.current < 1) clearArtifactProgress(design.id);
    };
  }, [design.id, clearArtifactProgress]);

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
          {previewUrl ? (
            <img src={previewUrl} alt={design.source_name} className="h-full w-full object-contain p-3" />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <ProgressRing value={fraction} className="size-10 text-muted-foreground" />
            </div>
          )}
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
      {/* Overlay actions are siblings (not nested in the card button — that'd be
          invalid HTML). Rename opens a dialog; removal is undoable, so no confirm. */}
      <div className="absolute left-2 top-2 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          onClick={() => setRenaming(true)}
          aria-label={t("designs.rename")}
          title={t("designs.rename")}
          className="cursor-pointer rounded-md bg-card/90 p-1 text-muted-foreground shadow-sm transition-colors hover:text-foreground"
        >
          <Settings className="size-4" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={t("designs.delete")}
          title={t("designs.delete")}
          className="cursor-pointer rounded-md bg-card/90 p-1 text-muted-foreground shadow-sm transition-colors hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      <RenameDesignModal open={renaming} onClose={() => setRenaming(false)} design={design} />
    </div>
  );
}
