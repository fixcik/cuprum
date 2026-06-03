import { useState } from "react";
import { Loader2, ShieldCheck, ChevronLeft, ChevronRight, FlipHorizontal2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { LayerStack, type StackLayer, type FocusTarget } from "@/components/import/LayerStack";
import type { DrcMarkerInput } from "@/components/preview/DrcMarkers";
import { Board3D } from "@/components/board3d/Board3D";
import { MetricsTab } from "@/components/preview/MetricsTab";
import { FeasibilityTab } from "@/components/preview/FeasibilityTab";
import type { Hole, BoardMetrics } from "@/lib/api";
import type { BoardMeshData } from "@/lib/boardMesh";
import type { Finding, Severity } from "@/lib/feasibility";

export type PreviewMode = "2d" | "3d";
/** Top-level pane tab. Owned by the parent (the wizard header hosts the switch). */
export type PreviewTab = "preview" | "metrics" | "feasibility";

/** One navigable problem for the on-preview stepper. */
export interface DrcIssue {
  fid: string;
  hi: number;
  label: string;
  value: string;
  severity: Severity;
}

const ISSUE_DOT: Record<Severity, string> = {
  block: "bg-destructive",
  warn: "bg-warning",
  info: "bg-muted-foreground",
  ok: "bg-success",
};

export function PreviewPane({
  layers,
  holes,
  mesh,
  visibleKeys,
  layerColors,
  side = "top",
  onSideChange,
  mirror = false,
  onMirrorChange,
  mode,
  onModeChange,
  notice,
  tab = "preview",
  metrics,
  metricsLoading,
  findings,
  markers,
  focusTarget,
  focus,
  onFocus,
  showDrc = false,
  onShowDrcChange,
  issues = [],
  issueIndex = -1,
  facing = null,
  onFacingChange,
  snapNonce = 0,
  loading,
}: {
  layers: StackLayer[];
  /** Drill holes to show in 2D (already filtered by the visible drill layers). */
  holes: Hole[];
  /** Triangulated 3D board mesh from the Rust core (null while loading). */
  mesh?: BoardMeshData | null;
  /** Keys of layers/drills visible in 3D. Undefined → show all. */
  visibleKeys?: Set<string>;
  /** Colour by layer key, for "other" 3D surface layers. */
  layerColors?: Record<string, string>;
  side?: "top" | "bottom";
  onSideChange?: (side: "top" | "bottom") => void;
  /** "Mirror" toggle for the bottom 2D view. Off (default) = real back-of-board
   *  view (reads correctly, matches 3D); on = see-through view whose X positions
   *  line up with the top. No effect on the top view. */
  mirror?: boolean;
  onMirrorChange?: (v: boolean) => void;
  mode: PreviewMode;
  onModeChange: (mode: PreviewMode) => void;
  /** Optional progress note (e.g. "Layers 3/6") shown while previews stream in. */
  notice?: string;
  /** Which tab to show. The switch itself lives in the wizard header. */
  tab?: PreviewTab;
  /** Measured board facts for the Metrics tab (null while loading). */
  metrics?: BoardMetrics | null;
  metricsLoading?: boolean;
  /** DFM verdict rows for the Feasibility tab. */
  findings?: Finding[];
  /** DRC dimension markers (board mm) drawn on the 2D view. */
  markers?: DrcMarkerInput[];
  /** Focus request for the 2D view (centre+zoom on a hotspot). */
  focusTarget?: FocusTarget | null;
  /** Currently focused hotspot (finding id + index), for the Feasibility stepper. */
  focus?: { fid: string; hi: number } | null;
  /** Focus a finding's hotspot (from the Feasibility tab) → centres the 2D view. */
  onFocus?: (fid: string, hi: number) => void;
  /** Whether the DRC marker overlay is shown on the 2D preview. */
  showDrc?: boolean;
  onShowDrcChange?: (v: boolean) => void;
  /** Navigable problems for the on-preview stepper, and the active one's index. */
  issues?: DrcIssue[];
  issueIndex?: number;
  /** The face the 3D camera currently looks at (null = tilted off-axis). Drives
   *  the Top/Bottom toggle highlight in 3D so it deselects when you orbit away. */
  facing?: "top" | "bottom" | null;
  onFacingChange?: (f: "top" | "bottom" | null) => void;
  /** Bumped on a side pick → tells Board3D to snap the camera onto that side. */
  snapNonce?: number;
  /** Forwarded to LayerStack: spinner while 2D layers load. */
  loading?: boolean;
}) {
  const { t } = useTranslation("common");
  // The 2D view's current px/mm scale, carried over so 3D opens at the same size.
  const [scale2d, setScale2d] = useState<number | undefined>(undefined);

  return (
    <div className="relative h-full w-full">
      {tab === "preview" ? (
        mode === "2d" ? (
          <LayerStack
            layers={layers}
            holes={holes}
            side={side}
            mirror={mirror}
            onScale={setScale2d}
            markers={showDrc ? markers : []}
            focusTarget={showDrc ? focusTarget : null}
            loading={loading}
          />
        ) : (
          <Board3D
            mesh={mesh ?? null}
            visibleKeys={visibleKeys}
            layerColors={layerColors}
            initialZoom={scale2d}
            side={side}
            onFacingChange={onFacingChange}
            snapNonce={snapNonce}
          />
        )
      ) : tab === "metrics" ? (
        <MetricsTab metrics={metrics ?? null} loading={metricsLoading} />
      ) : (
        <FeasibilityTab findings={findings ?? []} loading={metricsLoading} focus={focus} onFocus={onFocus} />
      )}

      {/* 2D/3D + side controls float over the canvas, only in the preview tab.
          Offset past the 2D edge rulers (RULER = 20px). */}
      {tab === "preview" && (
        <div className="absolute left-[26px] top-[26px] z-10 flex items-center gap-2">
          <SegmentedControl
            value={mode}
            onChange={onModeChange}
            options={[
              { value: "2d", label: "2D" },
              { value: "3d", label: "3D" },
            ]}
          />
          {onSideChange && (
            <SegmentedControl
              // In 3D the highlight follows the camera (deselects when tilted
              // off-axis); in 2D it's the chosen side.
              value={(mode === "3d" ? (facing ?? "__none__") : side) as "top" | "bottom"}
              onChange={onSideChange}
              options={[
                { value: "top", label: t("side.top") },
                { value: "bottom", label: t("side.bottom") },
              ]}
            />
          )}
          {notice && (
            <span className="flex items-center gap-1 rounded-md bg-card/80 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
              <Loader2 className="size-3 animate-spin" /> {notice}
            </span>
          )}
          {mode === "2d" && (findings ?? []).some((f) => (f.hotspots?.length ?? 0) > 0) && onShowDrcChange && (
            <label
              className="flex cursor-pointer items-center gap-1.5 rounded-md bg-card/80 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur"
              title={t("preview.drcToggleTitle")}
            >
              <ShieldCheck className="size-3.5" />
              {t("preview.drcLabel")}
              <Switch checked={showDrc} onCheckedChange={onShowDrcChange} />
            </label>
          )}
        </div>
      )}

      {/* Walk-the-errors stepper — floats top-centre while the overlay is on. */}
      {tab === "preview" && mode === "2d" && showDrc && issues.length > 0 && onFocus && (() => {
        const N = issues.length;
        const go = (delta: number) => {
          const next = issueIndex < 0 ? (delta > 0 ? 0 : N - 1) : (issueIndex + delta + N) % N;
          const it = issues[next];
          onFocus(it.fid, it.hi);
        };
        const cur = issueIndex >= 0 ? issues[issueIndex] : null;
        return (
          <div className="absolute left-1/2 top-[26px] z-10 flex -translate-x-1/2 items-center gap-1 rounded-md border border-border bg-card/90 px-1 py-1 text-[11px] shadow-sm backdrop-blur">
            <button
              type="button"
              className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-foreground/10"
              title={t("preview.prevIssue")}
              onClick={() => go(-1)}
            >
              <ChevronLeft className="size-4" />
            </button>
            {cur ? (
              <span className="flex items-center gap-1.5 px-1">
                <span className={`size-2 rounded-full ${ISSUE_DOT[cur.severity]}`} />
                <span className="text-foreground">{cur.label}</span>
                <span className="tabular-nums text-muted-foreground">{cur.value}</span>
                <span className="tabular-nums text-muted-foreground/70">
                  {issueIndex + 1}/{N}
                </span>
              </span>
            ) : (
              <span className="px-1 text-muted-foreground">{t("preview.stepperIssues", { count: N })}</span>
            )}
            <button
              type="button"
              className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-foreground/10"
              title={t("preview.nextIssue")}
              onClick={() => go(1)}
            >
              <ChevronRight className="size-4" />
            </button>
          </div>
        );
      })()}

      {/* Mirror toggle — only on the 2D bottom view, bottom-left so it clears the
          zoom toolbar. Off shows the bottom in top orientation (features stay put
          when flipping sides); on is a true back-of-board mirror. */}
      {tab === "preview" && mode === "2d" && side === "bottom" && onMirrorChange && (
        <label
          className="absolute bottom-2 left-2 z-10 flex cursor-pointer items-center gap-1.5 rounded-md bg-card/80 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur"
          title={t("preview.mirrorTitle")}
        >
          <FlipHorizontal2 className="size-3.5" />
          {t("preview.mirrorLabel")}
          <Switch checked={mirror} onCheckedChange={onMirrorChange} />
        </label>
      )}
    </div>
  );
}
