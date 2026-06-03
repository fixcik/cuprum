import { useState } from "react";
import { Loader2, ShieldCheck, ChevronLeft, ChevronRight, FlipHorizontal2, ListFilter } from "lucide-react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Switch } from "@/components/ui/Switch";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/Popover";
import { Checkbox } from "@/components/ui/Checkbox";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuCheckboxItem,
  ContextMenuItem,
} from "@/components/ui/ContextMenu";
import { LayerStack, type StackLayer, type FocusTarget } from "@/components/import/LayerStack";
import type { DrcMarkerInput } from "@/components/preview/DrcMarkers";
import { Board3D } from "@/components/board3d/Board3D";
import { MetricsTab } from "@/components/preview/MetricsTab";
import { FeasibilityTab } from "@/components/preview/FeasibilityTab";
import type { Hole, BoardMetrics } from "@/lib/api";
import type { BoardMeshData } from "@/lib/boardMesh";
import type { Finding, Severity, ProblemType } from "@/lib/feasibility";
import { SEVERITY } from "@/lib/severity";

/** One row in the DRC problem-type filter (funnel popover + right-click menu). */
export interface ProblemTypeOption {
  type: ProblemType;
  /** Worst severity among this type's findings — drives the colour dot. */
  severity: Severity;
  /** Already-translated display label. */
  label: string;
}

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
  problemTypes = [],
  hiddenTypes,
  onToggleType,
  onShowAllTypes,
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
  /** Problem types present on this design (with hotspots) for the overlay filter. */
  problemTypes?: ProblemTypeOption[];
  /** Types currently HIDDEN from the overlay/stepper (checkbox = !hidden). */
  hiddenTypes?: Set<ProblemType>;
  /** Toggle one problem type's overlay visibility. */
  onToggleType?: (t: ProblemType) => void;
  /** Clear all hides (show every type again). */
  onShowAllTypes?: () => void;
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

  // The problem-type filter (funnel + right-click) is live only while the 2D
  // overlay is on and there are located problems to filter.
  const filterReady = !!hiddenTypes && !!onToggleType && problemTypes.length > 0;
  const filterEnabled = filterReady && showDrc;
  const anyHidden = (hiddenTypes?.size ?? 0) > 0;

  return (
    <div className="relative h-full w-full">
      {tab === "preview" ? (
        mode === "2d" ? (
          // Right-click the board → the same problem-type filter as the funnel
          // popover. Disabled (native menu passes through) unless the filter is live.
          <ContextMenu>
            <ContextMenuTrigger asChild disabled={!filterEnabled}>
              <div className="h-full w-full">
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
              </div>
            </ContextMenuTrigger>
            {filterEnabled && (
              <ContextMenuContent>
                <ContextMenuLabel>{t("preview.filterHeading")}</ContextMenuLabel>
                {problemTypes.map((pt) => (
                  <ContextMenuCheckboxItem
                    key={pt.type}
                    checked={!hiddenTypes!.has(pt.type)}
                    onCheckedChange={() => onToggleType!(pt.type)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <span className={`size-2 rounded-full ${SEVERITY[pt.severity].dot}`} />
                    {pt.label}
                  </ContextMenuCheckboxItem>
                ))}
                {anyHidden && onShowAllTypes && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => onShowAllTypes()}>
                      {t("preview.filterShowAll")}
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuContent>
            )}
          </ContextMenu>
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
            <div className="flex items-center gap-1.5 rounded-md bg-card/80 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur">
              <label className="flex cursor-pointer items-center gap-1.5" title={t("preview.drcToggleTitle")}>
                <ShieldCheck className="size-3.5" />
                {t("preview.drcLabel")}
                <Switch checked={showDrc} onCheckedChange={onShowDrcChange} />
              </label>
              {/* Problem-type filter lives INSIDE the overlay pill (it only acts on
                  the overlay): a thin divider + funnel that opens the type popover. */}
              {filterEnabled && (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="relative -mr-1 flex cursor-pointer items-center gap-1.5 self-stretch rounded pl-1.5 pr-1 hover:text-foreground"
                      title={t("preview.filterTitle")}
                    >
                      <span className="h-3.5 w-px bg-border" />
                      <ListFilter className="size-3.5" />
                      {anyHidden && <span className="size-1.5 rounded-full bg-primary" />}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent align="end">
                    <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
                      {t("preview.filterHeading")}
                    </div>
                    {problemTypes.map((pt) => (
                      <label
                        key={pt.type}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover:bg-foreground/10"
                      >
                        <Checkbox
                          checked={!hiddenTypes!.has(pt.type)}
                          onCheckedChange={() => onToggleType!(pt.type)}
                        />
                        <span className={`size-2 rounded-full ${SEVERITY[pt.severity].dot}`} />
                        <span className="text-foreground">{pt.label}</span>
                      </label>
                    ))}
                    {anyHidden && onShowAllTypes && (
                      <button
                        type="button"
                        onClick={() => onShowAllTypes()}
                        className="mt-1 w-full cursor-pointer rounded px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
                      >
                        {t("preview.filterShowAll")}
                      </button>
                    )}
                  </PopoverContent>
                </Popover>
              )}
            </div>
          )}
        </div>
      )}

      {/* Walk-the-errors stepper — floats top-centre, level with the tool cluster.
          The cluster is narrow enough (filter folded into the overlay pill) that a
          centred row clears it at usable widths. */}
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
                <span className={`size-2 rounded-full ${SEVERITY[cur.severity].dot}`} />
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
