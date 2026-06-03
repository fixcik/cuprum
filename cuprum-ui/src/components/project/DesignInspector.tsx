import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Layers, ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { LayerPanel, type PanelRow } from "@/components/import/LayerPanel";
import { PreviewPane, type PreviewMode, type PreviewTab } from "@/components/preview/PreviewPane";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { EditableText } from "@/components/ui/EditableText";
import { colorFor, sideOf, stackOrder } from "@/lib/layerColors";
import { type LayerType } from "@/lib/api";
import {
  type ProblemType,
  type Severity,
  problemTypeOf,
  PROBLEM_TYPE_ORDER,
  VERDICT_KEY,
} from "@/lib/feasibility";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";
import { usePreviewData } from "@/hooks/usePreviewData";

/** Severity ranking for picking the worst across a problem-type's findings. */
const SEV_RANK: Record<Severity, number> = { ok: 0, info: 1, warn: 2, block: 3 };
const worseSeverity = (a: Severity | undefined, b: Severity): Severity =>
  a === undefined || SEV_RANK[b] > SEV_RANK[a] ? b : a;

interface DesignInspectorProps {
  designId: string;
  onBack: () => void;
}

// Identity is the gerber REL-PATH (g.path), matching project_board_mesh /
// project_board_metrics. LayerPanel keeps its numeric `index` = position in this
// design's gerbers[]; the inspector maps index -> gerbers[index].path at every
// call site that crosses into the store or a rel-path key set.
export function DesignInspector({ designId, onBack }: DesignInspectorProps) {
  const manifest = useShell((s) => s.currentManifest);
  const workingDir = useShell((s) => s.workingDir);
  const setDesignLayerType = useShell((s) => s.setDesignLayerType);
  const renameDesign = useShell((s) => s.renameDesign);
  const scheduleArtifactFlush = useShell((s) => s.scheduleArtifactFlush);
  const design = manifest?.designs.find((d) => d.id === designId) ?? null;
  const gerbers = useMemo(() => design?.gerbers ?? [], [design]);
  const overrides = manifest?.layer_colors;
  const profile = useSettings((s) => s.profile);

  const { t } = useTranslation(["feasibility", "common", "metrics", "import", "layers", "project"]);

  const [mode, setMode] = useState<PreviewMode>("2d");
  const [tab, setTab] = useState<PreviewTab>("preview");
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

  // DRC overlay on the preview is OFF by default (clean preview); it turns on
  // only when arriving from the Feasibility tab (clicking a finding) or via its
  // toggle — so the markers don't clutter casual browsing.
  const [showDrc, setShowDrc] = useState(false);
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
  // DRC marker focus: which finding's hotspot is highlighted/centred in 2D.
  const [focus, setFocus] = useState<{ fid: string; hi: number } | null>(null);
  const focusNonce = useRef(0);

  const pv = usePreviewData(workingDir, designId, gerbers, mode, side, {
    armed3d: mesh3dArmed,
    thicknessMm: manifest?.stackup?.substrate_thickness_mm,
    profile,
    panel: manifest?.panel,
    stackup: manifest?.stackup,
    overrides,
    excludeMask: false,
    onArtifactFresh: scheduleArtifactFlush,
    focus,
    focusNonce: focusNonce.current,
  });

  const onFocus = useCallback(
    (fid: string, hi: number) => {
      focusNonce.current += 1;
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

  // Filter the hook's markers/issues by the active type-filter. The hook computes
  // full unfiltered sets (so the verdict is never affected); here we apply the
  // EPHEMERAL view-only filter before passing to PreviewPane.
  // Marker keys are `${fid}#${i}` or `${fid}~hover#${i}` — extract fid to map type.
  const visibleMarkers = useMemo(() => {
    if (hiddenTypes.size === 0) return pv.markers;
    return pv.markers.filter((m) => {
      const fid = m.key.includes("~hover#") ? m.key.split("~hover#")[0] : m.key.split("#")[0];
      const tp = problemTypeOf(fid);
      return !tp || !hiddenTypes.has(tp);
    });
  }, [pv.markers, hiddenTypes]);

  const visibleIssues = useMemo(() => {
    if (hiddenTypes.size === 0) return pv.issues;
    return pv.issues.filter((issue) => {
      const tp = problemTypeOf(issue.fid);
      return !tp || !hiddenTypes.has(tp);
    });
  }, [pv.issues, hiddenTypes]);

  const issueIndex = focus ? visibleIssues.findIndex((n) => n.fid === focus.fid && n.hi === focus.hi) : -1;

  // Toggling the overlay on (manually) jumps to the first problem so there's
  // something to look at; toggling off just hides it.
  const onShowDrcChange = useCallback(
    (v: boolean) => {
      setShowDrc(v);
      if (v && issueIndex < 0 && visibleIssues.length > 0) onFocus(visibleIssues[0].fid, visibleIssues[0].hi);
    },
    [visibleIssues, issueIndex, onFocus],
  );

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
            visible: hasContent && !pv.hidden.has(g.path) && (mode === "3d" || sideOf(g.layer_type) === side || sideOf(g.layer_type) === "both"),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [gerbers, pv.files, pv.hidden, overrides, mode, side],
  );

  // index = position in gerbers[]; map to the rel-path before touching the store
  // (layer-type edit, persisted + undoable).
  const onType = (index: number, type: LayerType) => {
    const g = gerbers[index];
    if (g) void setDesignLayerType(designId, g.path, type);
  };

  if (!design) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ChevronLeft className="size-4" /> {t("project:designs.back")}
          </Button>
          <EditableText
            value={design.source_name}
            onCommit={(name) => void renameDesign(designId, name)}
            title={t("project:designs.rename")}
            ariaLabel={t("project:designs.rename")}
            className="max-w-[32ch] text-[13px] font-semibold text-foreground"
          />
        </div>
        <div className="flex items-center gap-2">
          {pv.hasRequired && (
            <SegmentedControl
              value={tab}
              onChange={setTab}
              options={[
                { value: "preview", label: t("import:tab.preview") },
                {
                  value: "metrics",
                  label: t("import:tab.metrics"),
                  icon: pv.metricsLoading ? <Loader2 className="size-3 animate-spin" /> : undefined,
                },
                {
                  value: "feasibility",
                  label: t("import:tab.feasibility"),
                  title: pv.metricsLoading ? t("import:state.checking") : pv.metrics ? t(VERDICT_KEY[pv.verdict]) : undefined,
                  // Tint the whole tab by verdict (not just a tiny dot) so a real
                  // problem is hard to miss; ok stays neutral.
                  tone: pv.metricsLoading || !pv.metrics ? undefined : pv.verdict === "block" ? "danger" : pv.verdict === "warn" ? "warning" : undefined,
                  icon: pv.metricsLoading ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : pv.metrics ? (
                    <span
                      className={`size-2 rounded-full ${
                        pv.verdict === "block"
                          ? "bg-destructive"
                          : pv.verdict === "warn"
                            ? "bg-warning"
                            : "bg-success"
                      }`}
                    />
                  ) : undefined,
                },
              ]}
            />
          )}
        </div>
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
              markers={visibleMarkers}
              focusTarget={pv.focusTarget}
              focus={focus}
              onFocus={onFocus}
              showDrc={showDrc}
              onShowDrcChange={onShowDrcChange}
              issues={visibleIssues}
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
    </div>
  );
}
