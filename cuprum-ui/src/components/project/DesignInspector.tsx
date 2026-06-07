import { useEffect, useMemo, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Layers, Eye, Ruler, ShieldCheck, Settings } from "lucide-react";
import { LayerPanel, type PanelRow } from "@/components/import/LayerPanel";
import { PreviewPane, type PreviewMode, type PreviewTab } from "@/components/preview/PreviewPane";
import { NavTabs, type NavTab } from "@/components/ui/NavTabs";
import { DesignSettingsModal } from "@/components/project/DesignSettingsModal";
import { VerdictDot } from "@/components/ui/VerdictDot";
import { colorFor, sideOf, stackOrder } from "@/lib/layerColors";
import {
  type LayerType,
  type Manifest,
} from "@/lib/api";
import type { ProblemType, Severity } from "@/lib/feasibility";
import { problemTypeOf, PROBLEM_TYPE_ORDER, VERDICT_KEY } from "@/lib/feasibility";
import { worseSeverity } from "@/lib/severity";
import { useSettings } from "@/settingsStore";
import { usePreviewData } from "@/hooks/usePreviewData";

interface DesignInspectorProps {
  designId: string;
  manifest: Manifest;
  workingDir: string;
  onRenameDesign: (name: string) => void;
  onSetLayerType: (path: string, type: LayerType) => void;
  onArtifactsFresh: (fresh: boolean) => void;
  /** Fired once the preview has real content to show (first 2D layer painted, or
   *  the missing-layers panel). Lets the host window defer reveal until ready. */
  onReady?: () => void;
}

// Identity is the gerber REL-PATH (g.path), matching project_board_mesh /
// project_board_metrics. LayerPanel keeps its numeric `index` = position in this
// design's gerbers[]; the inspector maps index -> gerbers[index].path at every
// call site that crosses into the store or a rel-path key set.
export function DesignInspector({
  designId,
  manifest,
  workingDir,
  onRenameDesign,
  onSetLayerType,
  onArtifactsFresh,
  onReady,
}: DesignInspectorProps) {
  const design = manifest.designs.find((d) => d.id === designId) ?? null;
  const gerbers = useMemo(() => design?.gerbers ?? [], [design]);

  const { t } = useTranslation(["feasibility", "common", "metrics", "import", "layers", "project"]);

  const [mode, setMode] = useState<PreviewMode>("2d");
  const [tab, setTab] = useState<PreviewTab>("preview");
  // Design-settings modal (rename), opened from the header gear — replaces the old
  // inline editable title.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [side, setSide] = useState<"top" | "bottom">("top");
  // "Mirror" toggle for the bottom 2D view (off by default = real back-of-board
  // view; on = see-through aligned with the top). Toggled from the preview switch.
  const [mirrorBottom, setMirrorBottom] = useState(false);
  // 3D camera facing (null = orbited off-axis) + a nonce to snap the camera onto
  // a side when the toggle is clicked.
  const [facing, setFacing] = useState<"top" | "bottom" | null>("top");
  const [snapNonce, setSnapNonce] = useState(0);
  const pickSide = useCallback((v: "top" | "bottom") => {
    setSide(v);
    setFacing(v);
    setSnapNonce((n) => n + 1);
  }, []);
  // Lazy 3D: the inspector opens in 2D, so don't pay for the (expensive) mesh
  // build until the user actually opens the 3D view at least once. Latches true
  // on the first switch to 3D and stays armed for the rest of the session, so
  // returning to 3D is instant and edits keep the mesh fresh.
  const [mesh3dArmed, setMesh3dArmed] = useState(false);
  useEffect(() => {
    if (mode === "3d") setMesh3dArmed(true);
  }, [mode]);

  const overrides = manifest?.layer_colors;
  const profile = useSettings((s) => s.profile);

  // Per-problem-type overlay visibility — an EPHEMERAL view aid (not persisted),
  // reset when the design changes. A type in the set is hidden from the 2D overlay
  // and the stepper; the verdict is never affected. Toggled from the on-preview
  // filter (funnel popover + right-click context menu).
  const [hiddenTypes, setHiddenTypes] = useState<Set<ProblemType>>(() => new Set());
  useEffect(() => {
    setHiddenTypes(new Set());
  }, [designId]);
  const toggleType = useCallback((tp: ProblemType) => {
    setHiddenTypes((prev) => {
      const next = new Set(prev);
      if (next.has(tp)) next.delete(tp);
      else next.add(tp);
      return next;
    });
  }, []);
  const showAllTypes = useCallback(() => setHiddenTypes(new Set()), []);

  // DRC overlay on the preview is OFF by default (clean preview); it turns on
  // only when arriving from the Feasibility tab (clicking a finding) or via its
  // toggle — so the markers don't clutter casual browsing.
  const [showDrc, setShowDrc] = useState(false);
  // DRC marker focus: which finding's hotspot is highlighted/centred in 2D.
  const [focus, setFocus] = useState<{ fid: string; hi: number } | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);

  const pv = usePreviewData(workingDir, designId, gerbers, mode, side, {
    armed3d: mesh3dArmed,
    thicknessMm: manifest?.stackup?.substrate_thickness_mm,
    profile,
    panel: manifest?.panel,
    stackup: manifest?.stackup,
    overrides,
    onArtifactFresh: onArtifactsFresh,
    focus,
    focusNonce,
    hiddenTypes,
  });

  // Signal "ready to view" to the host window: the preview pane has real content —
  // either the first 2D layer has painted, or the design is missing required layers
  // (so the missing-layers panel is what we show). Until then the window stays
  // hidden so it doesn't flash an empty/loading preview that then pops in.
  const previewReady = !pv.hasRequired || pv.layers.length > 0;
  useEffect(() => {
    if (previewReady) onReady?.();
  }, [previewReady, onReady]);

  const onFocus = useCallback(
    (fid: string, hi: number) => {
      setFocusNonce((n) => n + 1);
      setFocus({ fid, hi });
      setShowDrc(true);
      setTab("preview");
      setMode("2d");
      // Reveal the right face so the focused marker isn't filtered out.
      const f = pv.findings.find((x) => x.id === fid);
      // For highlightAll findings hi indexes hoverBoxes; otherwise hotspots.
      const hs = f?.highlightAll ? f.hoverBoxes?.[hi]?.side : f?.hotspots?.[hi]?.side;
      if (hs === "top" || hs === "bottom") setSide(hs);
    },
    [pv.findings],
  );

  // If the user hides the problem type that's currently focused, drop the focus —
  // otherwise the 2D camera stays centred on a marker that's no longer drawn.
  // Scoped to a hidden TYPE (not an off-side marker, which keeps its focus so
  // switching back restores it).
  useEffect(() => {
    if (!focus) return;
    const tp = problemTypeOf(focus.fid);
    if (tp && hiddenTypes.has(tp)) setFocus(null);
  }, [hiddenTypes, focus]);

  // Problem types actually present on THIS design (with hotspots) — the filter
  // menu lists only these. Severity is the worst among a type's findings; the
  // visibility checkbox reflects `hiddenTypes`.
  const problemTypes = useMemo(() => {
    const sev = new Map<ProblemType, Severity>();
    for (const f of pv.findings) {
      if ((f.hotspots?.length ?? 0) === 0) continue;
      const tp = problemTypeOf(f.id);
      if (!tp) continue;
      sev.set(tp, worseSeverity(sev.get(tp), f.severity));
    }
    return PROBLEM_TYPE_ORDER.filter((tp) => sev.has(tp)).map((tp) => ({
      type: tp,
      severity: sev.get(tp)!,
      label: t(`feasibility:filter.type.${tp}`),
    }));
  }, [pv.findings, t]);

  const issueIndex = focus ? pv.issues.findIndex((n) => n.fid === focus.fid && n.hi === focus.hi) : -1;

  // Toggling the overlay on (manually) jumps to the first problem so there's
  // something to look at; toggling off just hides it.
  const onShowDrcChange = useCallback(
    (v: boolean) => {
      setShowDrc(v);
      if (v && issueIndex < 0 && pv.issues.length > 0) onFocus(pv.issues[0].fid, pv.issues[0].hi);
    },
    [pv.issues, issueIndex, onFocus],
  );

  // index = position in gerbers[]; map to the rel-path before touching the store
  // (layer-type edit, persisted + undoable).
  const onType = (index: number, type: LayerType) => {
    const g = gerbers[index];
    if (g) onSetLayerType(g.path, type);
  };

  // A drill layer has no SVG preview but DOES have holes to show/hide — treat it
  // as toggleable content just like the other layers. `index` = position in
  // gerbers[]; key/identity is the rel-path.
  const rows: PanelRow[] = useMemo(
    () =>
      gerbers
        .map((g, i) => {
          const f = pv.files[i];
          const loading = f?.svgStatus === "pending";
          const hasContent =
            f?.svgStatus === "loaded" || (g.layer_type === "drill" && (f?.holes.length ?? 0) > 0);
          return {
            key: g.path,
            index: i,
            filename: f?.filename ?? (g.path.split("/").pop() ?? g.path),
            type: g.layer_type,
            color: colorFor(g.layer_type, overrides),
            visible: hasContent && pv.isVisible(g.layer_type, g.path),
            hasPreview: hasContent,
            loading,
            drillError: f?.drillError,
          };
        })
        // In 2D only list the selected side's layers (+ shared ones: contour,
        // drill, inner, other = side "both"); 3D lists everything.
        .filter((r) => mode === "3d" || sideOf(r.type) === side || sideOf(r.type) === "both")
        // Sort by physical stack (bottom → top); ties keep gerber order.
        .sort((a, b) => stackOrder(a.type) - stackOrder(b.type) || a.index - b.index),
    [gerbers, pv.files, pv.isVisible, overrides, mode, side],
  );

  if (!design) return null;

  // Project-style header tabs (icon + label), with the metrics spinner and the
  // verdict status preserved. Tint the "feasibility" tab by verdict so a real
  // problem is hard to miss; ok stays neutral.
  const tabs: NavTab<PreviewTab>[] = [
    { id: "preview", label: t("import:tab.preview"), icon: <Eye className="size-4" /> },
    {
      id: "metrics",
      label: t("import:tab.metrics"),
      icon: pv.metricsLoading ? <Loader2 className="size-4 animate-spin" /> : <Ruler className="size-4" />,
    },
    {
      id: "feasibility",
      label: t("import:tab.feasibility"),
      title: pv.metricsLoading ? t("import:state.checking") : pv.metrics ? t(VERDICT_KEY[pv.verdict]) : undefined,
      tone: pv.metricsLoading || !pv.metrics ? undefined : pv.verdict === "block" ? "danger" : pv.verdict === "warn" ? "warning" : undefined,
      icon: pv.metricsLoading ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />,
      trailing: !pv.metricsLoading && pv.metrics ? <VerdictDot verdict={pv.verdict} className="size-2" /> : undefined,
    },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Bambu-style header: tabs on the left, gear (rename) on the right — mirrors
          the project page. The design name lives in the OS window title. */}
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        {pv.hasRequired && <NavTabs tabs={tabs} value={tab} onChange={setTab} />}
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          aria-label={t("project:designs.rename")}
          title={t("project:designs.rename")}
          className="ml-auto rounded-lg p-2 text-muted-foreground transition-colors hover:text-foreground"
        >
          <Settings className="size-4" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <LayerPanel rows={rows} onType={onType} onToggle={pv.toggle} />
        <div className="min-w-0 flex-1">
          {pv.hasRequired ? (
            <PreviewPane
              layers={pv.layers}
              holes={pv.visibleHoles}
              mesh={pv.mesh}
              visibleKeys={pv.visibleKeys}
              layerColors={pv.layerColors}
              side={side}
              onSideChange={pickSide}
              mirror={mirrorBottom}
              onMirrorChange={setMirrorBottom}
              facing={facing}
              onFacingChange={setFacing}
              snapNonce={snapNonce}
              mode={mode}
              onModeChange={setMode}
              notice={pv.previewNotice}
              tab={tab}
              metrics={pv.metrics}
              metricsLoading={pv.metricsLoading}
              findings={pv.findings}
              markers={pv.markers}
              focusTarget={pv.focusTarget}
              focus={focus}
              onFocus={onFocus}
              showDrc={showDrc}
              onShowDrcChange={onShowDrcChange}
              issues={pv.issues}
              issueIndex={issueIndex}
              problemTypes={problemTypes}
              hiddenTypes={hiddenTypes}
              onToggleType={toggleType}
              onShowAllTypes={showAllTypes}
              loading={pv.layersLoading}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
              <Layers className="size-12 text-muted-foreground/50" />
              <div className="text-[15px] font-semibold text-foreground">{t("import:missing.title")}</div>
              <p className="max-w-sm text-[12px] leading-relaxed text-muted-foreground">
                {t("import:missing.descriptionPrefix")}{" "}
                <span className="text-foreground">{pv.missing.map((lt) => t(`layers:${lt}`)).join(", ")}</span>.{" "}
                {t("import:missing.descriptionSuffix")}
              </p>
            </div>
          )}
        </div>
      </div>

      <DesignSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        name={design.source_name}
        onRename={onRenameDesign}
      />
    </div>
  );
}
