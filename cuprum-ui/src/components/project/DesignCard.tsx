import { useEffect, useMemo, useRef, useState } from "react";
import { Settings, Trash2, LayoutGrid } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, type ProjectDesign } from "@/lib/api";
import { type Verdict, VERDICT_KEY } from "@/lib/feasibility";
import { SEVERITY } from "@/lib/severity";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { useDesignVerdict } from "@/hooks/useDesignVerdict";
import { RenameDesignModal } from "@/components/project/RenameDesignModal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ProgressRing } from "@/components/ui/ProgressRing";
import { ringFraction } from "@/lib/artifactProgress";

export function DesignCard({
  design,
  onOpen,
  onDelete,
  onVerdict,
}: {
  design: ProjectDesign;
  onOpen: () => void;
  onDelete: () => void;
  /** Reports the design's settled DFM verdict (or null) up to the gallery, which
   *  aggregates them for the header summary. Stable identity expected (useCallback). */
  onVerdict?: (id: string, v: Verdict | null) => void;
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
  const [renaming, setRenaming] = useState(false);
  // Confirm before deleting a design that's placed on the panel (the delete
  // cascades its BoardInstances off the panel — don't drop them silently).
  const [confirming, setConfirming] = useState(false);
  const [svgReady, setSvgReady] = useState(false);
  const { fmtLen } = useUnitFormat();

  // Copies of this design already placed on the current panel — drives the badge.
  const placedCount = panel?.instances.filter((i) => i.design_id === design.id).length ?? 0;

  // Board size + DFM verdict (lazy, cached on disk). The size chip shows even for
  // an incomplete design; the verdict chip stays null until the required layers are
  // present (handled inside the hook).
  const { verdict, size, settled: metricsReady } = useDesignVerdict(workingDir, design.gerbers, profile, {
    panel,
    stackup,
    traceSession,
    onMetrics: scheduleArtifactFlush,
  });

  // Report the settled verdict up to the gallery (onVerdict is stable).
  useEffect(() => {
    onVerdict?.(design.id, verdict);
  }, [design.id, verdict, onVerdict]);

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

  // Use contain for portrait/strongly-elongated boards and while size is unknown;
  // cover otherwise (landscape boards fill the frame better).
  const containFit = !size || size.h > size.w || Math.min(size.w, size.h) / Math.max(size.w, size.h) < 0.6;

  // Pre-extract the verdict icon so it can be rendered without conditional JSX.
  const VIcon = verdict ? SEVERITY[verdict].Icon : null;

  return (
    <div className="group relative">
      {/* Main card button — wraps preview + footer. Interactive overlays are siblings
          to avoid nesting <button> inside <button> (invalid HTML). */}
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-primary/50"
      >
        {/* Preview area */}
        <div className="pcb-grid relative aspect-[4/3] w-full overflow-hidden">
          {previewUrl ? (
            <img
              src={previewUrl}
              alt={design.source_name}
              className={containFit ? "h-full w-full object-contain p-3 drop-shadow-[0_6px_14px_rgba(0,0,0,.55)]" : "h-full w-full object-cover"}
            />
          ) : (
            <div className="grid h-full w-full place-items-center">
              <ProgressRing value={fraction} className="size-10 text-muted-foreground" />
            </div>
          )}
          {/* Bottom gradient fade */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/55 to-transparent" />
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-0.5 p-3">
          <div className="truncate text-[13px] font-semibold text-foreground">{design.source_name}</div>
          <div className="truncate text-[11px] tabular-nums text-muted-foreground">
            {t("designs.layerCount", { count: design.gerbers.length })}
            {size ? ` · ${fmtLen(size.w)} × ${fmtLen(size.h)}` : ""}
          </div>
        </div>
      </button>

      {/* Overlay layer — sits on top of the card button, covering only the preview zone.
          Non-interactive by default; individual interactive children opt in via pointer-events-auto. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 aspect-[4/3]">
        {/* Verdict chip — top-right corner */}
        {verdict && VIcon && (
          <span
            className={`absolute right-2 top-2 inline-flex items-center gap-1 rounded-md bg-card/90 px-1.5 py-0.5 text-[10px] font-medium shadow-sm ring-1 ring-border/60 backdrop-blur ${SEVERITY[verdict].fg}`}
          >
            <VIcon className="size-3" />
            {t(VERDICT_KEY[verdict])}
          </span>
        )}

        {/* On-panel badge — bottom-left */}
        {placedCount > 0 && (
          <span className="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md bg-card/90 px-1.5 py-0.5 text-[10px] font-medium text-foreground shadow-sm ring-1 ring-border/60 backdrop-blur">
            <LayoutGrid className="size-3 text-primary" />
            {t("designs.onPanel", { count: placedCount })}
          </span>
        )}
      </div>

      {/* Rename / delete controls — top-left corner, siblings to the card button */}
      <div className="absolute left-2 top-2 flex gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
        <button
          type="button"
          onClick={() => setRenaming(true)}
          aria-label={t("designs.rename")}
          title={t("designs.rename")}
          className="grid size-7 cursor-pointer place-items-center rounded-md bg-card/90 text-muted-foreground shadow-sm ring-1 ring-border/60 transition-colors hover:text-foreground"
        >
          <Settings className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => (placedCount > 0 ? setConfirming(true) : onDelete())}
          aria-label={t("designs.delete")}
          title={t("designs.delete")}
          className="grid size-7 cursor-pointer place-items-center rounded-md bg-card/90 text-muted-foreground shadow-sm ring-1 ring-border/60 transition-colors hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </button>
      </div>

      <RenameDesignModal open={renaming} onClose={() => setRenaming(false)} design={design} />
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={onDelete}
        title={t("designs.deleteConfirm.title")}
        message={t("designs.deleteConfirm.message", { name: design.source_name, count: placedCount })}
        confirmLabel={t("designs.deleteConfirm.confirm")}
        cancelLabel={t("designs.deleteConfirm.cancel")}
      />
    </div>
  );
}
