import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useTranslation } from "react-i18next";
import { Search, UploadCloud, Download, Loader2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { api, type AddDesignSnapshot, type ProjectDesign, type PanelDoc } from "@/lib/api";
import { DesignPickerRow } from "@/components/project/DesignPickerRow";
import { Button } from "@/components/ui/Button";
import { useSettings } from "@/settingsStore";
import { useShell } from "@/shellStore";
import { VerdictBadge } from "@/components/preview/VerdictBadge";
import { PreviewPane, type PreviewMode } from "@/components/preview/PreviewPane";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { PanelLayoutPreview } from "@/components/panel/PanelLayoutPreview";
import { NestingControls } from "@/components/panel/NestingControls";
import { packLayoutAvoiding, panelObstacles, boxesForInstances } from "@/lib/panelPlacement";
import { usePreviewData } from "@/hooks/usePreviewData";
import { useSnapshotSubscription } from "@/hooks/useTauriListeners";

/** Root of the separate "Add design to panel" window (label "add-design"). */
export function AddDesignWindow() {
  const { t } = useTranslation("project");
  // Subscribe to project snapshots, announcing readiness only after the listener
  // is live (so the main window's reply can't land before it and be dropped).
  const snap = useSnapshotSubscription<AddDesignSnapshot>(api.onAddDesignSnapshot, api.emitAddDesignReady);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const prevIdsRef = useRef<Set<string>>(new Set());
  const snapReceivedRef = useRef(false);
  const profile = useSettings((s) => s.profile);
  const nest = useSettings((s) => s.nest);

  // Local preview UI state for the PreviewPane.
  const [mode, setMode] = useState<PreviewMode>("2d");
  const [side, setSide] = useState<"top" | "bottom">("top");
  const [showDrc, setShowDrc] = useState(false);
  const [focus, setFocus] = useState<{ fid: string; hi: number } | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [armed3d, setArmed3d] = useState(false);
  useEffect(() => { if (mode === "3d") setArmed3d(true); }, [mode]);

  // Accurate 2D real-size requires the display scale.
  useEffect(() => { void useShell.getState().loadDisplayScale(); }, []);

  // Preview mode: "design" shows the PreviewPane, "layout" shows the panel preview.
  const [previewMode, setPreviewMode] = useState<"design" | "layout">("design");

  // When nesting is enabled, default to the layout view.
  useEffect(() => {
    if (nest.enabled) setPreviewMode("layout");
  }, [nest.enabled]);

  useEffect(() => {
    getCurrentWindow().setTitle(t("panel.add.window.title")).catch(() => {});
  }, [t]);

  // Apply a preselect carried by the snapshot (e.g. "add this design to panel"
  // invoked from the main window) once it's present in the list. The preselect is
  // one-shot on the main side, so later snapshots won't re-trigger this.
  useEffect(() => {
    if (snap?.preselectDesignId && snap.designs.some((d) => d.id === snap.preselectDesignId)) {
      setSelectedId(snap.preselectDesignId);
    }
  }, [snap]);

  const designs: ProjectDesign[] = snap?.designs ?? [];
  const workingDir = snap?.workingDir ?? null;
  const panel = snap?.panel ?? { widthMm: 100, heightMm: 100 };
  const filtered = designs.filter((d) =>
    d.source_name.toLowerCase().includes(query.toLowerCase()),
  );
  const selected =
    selectedId && designs.some((d) => d.id === selectedId) ? selectedId : null;
  const selectedDesign = designs.find((d) => d.id === selected) ?? null;

  // Auto-select a freshly imported design when the snapshot updates with a new id.
  useEffect(() => {
    const ids = new Set(designs.map((d) => d.id));
    const freshIds = designs.filter((d) => !prevIdsRef.current.has(d.id));
    if (snapReceivedRef.current && freshIds.length > 0) {
      // Select the most recently imported design (appended last).
      setSelectedId(freshIds[freshIds.length - 1].id);
    }
    snapReceivedRef.current = true;
    prevIdsRef.current = ids;
  }, [designs]);

  // PanelDoc for DFM evaluate — minimal, never persisted.
  const panelDoc: PanelDoc = useMemo(() => ({
    schema_version: 2,
    width_mm: panel.widthMm,
    height_mm: panel.heightMm,
    origin_x_mm: 0,
    origin_y_mm: 0,
    instances: [],
    tooling_holes: [],
  }), [panel.widthMm, panel.heightMm]);

  // All preview data for the selected design (SVG layers, mesh, metrics, DRC).
  const pv = usePreviewData(
    workingDir,
    selectedDesign?.id ?? "",
    selectedDesign?.gerbers ?? [],
    mode,
    side,
    { armed3d, profile, panel: panelDoc, stackup: null, excludeMask: true, focus, focusNonce },
  );

  // Derive board size and verdict from the hook (replaces duplicate metrics fetch).
  const selSize = pv.metrics ? { w: pv.metrics.board.widthMm, h: pv.metrics.board.heightMm } : null;
  const selVerdict = pv.hasRequired && pv.metrics ? pv.verdict : null;

  // Toast state for the add-to-panel result.
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const pending = api.onAddDesignResult((r) => {
      if (r.ok) {
        void getCurrentWindow().close();
      } else {
        setToast(t(r.messageKey, r.params as Record<string, string> | undefined));
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToast(null), 2600);
      }
    });
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      void pending.then((un) => un());
    };
  }, [t]);

  const addToPanel = () => {
    if (selected) void api.emitAddDesignAddToPanel(selected, nest);
  };

  const pickZips = useCallback(async () => {
    const picked = await openDialog({
      multiple: true,
      filters: [{ name: "ZIP", extensions: ["zip"] }],
    });
    const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
    if (paths.length > 0) void api.emitAddDesignImport(paths);
  }, []);

  // OS drag-and-drop: accept ZIP files dropped onto this window.
  useEffect(() => {
    const pending = getCurrentWebview().onDragDropEvent((e) => {
      if (e.payload.type === "enter" || e.payload.type === "over") setDragOver(true);
      else if (e.payload.type === "leave") setDragOver(false);
      else if (e.payload.type === "drop") {
        setDragOver(false);
        const zips = e.payload.paths.filter((p) => p.toLowerCase().endsWith(".zip"));
        if (zips.length > 0) void api.emitAddDesignImport(zips);
      }
    });
    return () => void pending.then((un) => un());
  }, []);

  // Full obstacle set (boards + tooling holes) for the fit-line packer.
  const existingBoxes = useMemo(
    () =>
      panelObstacles(
        { instances: snap?.instances ?? [], tooling_holes: snap?.tooling_holes ?? [] },
        snap?.placedSizes ?? {},
      ),
    [snap],
  );
  // Board-only boxes for the preview's dim squares; the preview folds tooling holes
  // (passed separately) into its own packer and draws them as circles.
  const boardBoxes = useMemo(
    () => boxesForInstances(snap?.instances ?? [], snap?.placedSizes ?? {}),
    [snap],
  );

  const clearance = nest.enabled ? nest.gapMm : 0;

  // Footer fit-line: summarises how many copies will land on the panel.
  const fit = useMemo(() => {
    if (!selectedDesign || !selSize) return { text: t("panel.add.footerPick"), warn: false };
    const p = packLayoutAvoiding(selSize.w, selSize.h, panel.widthMm, panel.heightMm, nest, existingBoxes, clearance);
    if (p.max === 0) return { text: t("panel.add.fit.tooBig"), warn: true };
    if (p.n === 0) return { text: t("panel.add.fit.noSpace"), warn: true };
    if (!nest.enabled) return { text: t("panel.add.fit.one"), warn: false };
    if (p.requested > p.n)
      return { text: t("panel.add.fit.overflow", { fit: p.n, requested: p.requested, missing: p.requested - p.n }), warn: true };
    return { text: t("panel.add.fit.grid", { cols: p.cols, rows: p.rows, n: p.n }), warn: false };
  }, [selectedDesign, selSize, panel.widthMm, panel.heightMm, nest, existingBoxes, clearance, t]);

  return (
    <div className="relative flex h-screen w-screen flex-col bg-card text-foreground">
      {/* No in-window header: the OS title bar already shows the localised title
          (set via setTitle) and provides window close. The footer Cancel + the
          native close button cover dismissal. */}
      <div className="flex min-h-0 flex-1">
        {/* left: list */}
        <div className="flex w-[320px] shrink-0 flex-col border-r border-border bg-panel">
          <div className="border-b border-border p-3">
            <div className="relative w-full">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
                <Search className="size-3.5" />
              </span>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("panel.add.searchPlaceholder")}
                className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
              />
            </div>
            <div className="mt-2 px-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t("panel.add.designsHeader")}{" "}
              <span className="font-normal normal-case text-muted-foreground/70">· {designs.length}</span>
            </div>
          </div>
          <ul className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
            {workingDir && filtered.length > 0 ? (
              filtered.map((d) => (
                <DesignPickerRow
                  key={d.id}
                  design={d}
                  workingDir={workingDir}
                  panel={panel}
                  selected={d.id === selected}
                  onSelect={() => setSelectedId(d.id)}
                />
              ))
            ) : (
              <li className="px-2 py-6 text-center text-[12px] text-muted-foreground">
                {t("panel.add.empty")}
              </li>
            )}
          </ul>
          <div className="border-t border-border p-2">
            <button
              type="button"
              onClick={() => void pickZips()}
              className="flex w-full flex-col items-center gap-1 rounded-md border-2 border-dashed border-border px-3 py-3 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
            >
              <UploadCloud className="size-5" />
              <span className="text-[12px] font-medium">{t("panel.add.importTitle")}</span>
              <span className="text-[11px] text-muted-foreground/70">{t("panel.add.importHint")}</span>
            </button>
          </div>
        </div>

        {/* right: preview */}
        <div className="flex min-w-0 flex-1 flex-col">
          {selectedDesign ? (
            <>
              <div className="flex items-center gap-2 border-b border-border p-3">
                <SegmentedControl<"design" | "layout">
                  value={previewMode}
                  onChange={setPreviewMode}
                  options={[
                    { value: "design", label: t("panel.add.previewDesign") },
                    { value: "layout", label: t("panel.add.previewLayout") },
                  ]}
                />
              </div>
              {previewMode === "layout" ? (
                selSize ? (
                  <PanelLayoutPreview
                    boardWmm={selSize.w}
                    boardHmm={selSize.h}
                    panelWmm={panel.widthMm}
                    panelHmm={panel.heightMm}
                    nest={nest}
                    obstacles={boardBoxes}
                    clearanceMm={clearance}
                    toolingHoles={snap?.tooling_holes ?? []}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted-foreground">
                    <Loader2 className="size-4 animate-spin" />
                    {t("panel.add.layoutLoading")}
                  </div>
                )
              ) : (
                <div className="flex min-h-0 flex-1 flex-col">
                  <div className="relative min-h-0 flex-1">
                    <PreviewPane
                      layers={pv.layers}
                      holes={pv.visibleHoles}
                      mesh={pv.mesh}
                      visibleKeys={pv.visibleKeys}
                      layerColors={pv.layerColors}
                      side={side}
                      onSideChange={setSide}
                      mode={mode}
                      onModeChange={setMode}
                      notice={pv.previewNotice}
                      metrics={pv.metrics}
                      metricsLoading={pv.metricsLoading}
                      findings={pv.findings}
                      markers={pv.markers}
                      focusTarget={pv.focusTarget}
                      focus={focus}
                      onFocus={(fid, hi) => { setFocus({ fid, hi }); setFocusNonce((n) => n + 1); setShowDrc(true); setMode("2d"); }}
                      showDrc={showDrc}
                      onShowDrcChange={setShowDrc}
                      issues={pv.issues}
                      issueIndex={focus ? pv.issues.findIndex((n) => n.fid === focus.fid && n.hi === focus.hi) : -1}
                      loading={pv.layersLoading}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2">
                    <span className="truncate text-[12px] font-medium text-foreground">{selectedDesign.source_name}</span>
                    {selVerdict && <VerdictBadge verdict={selVerdict} />}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-[12px] text-muted-foreground">
              {t("panel.add.pickHint")}
            </div>
          )}
        </div>
      </div>

      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10">
          <div className="flex flex-col items-center gap-2 text-primary">
            <Download className="size-7" />
            <span className="text-[13px] font-medium">{t("panel.add.dropHint")}</span>
          </div>
        </div>
      )}

      <NestingControls />

      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <span className={`text-[11px] ${fit.warn ? "text-warning" : "text-muted-foreground"}`}>
          {fit.text}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => void getCurrentWindow().close()}>
            {t("panel.add.cancel")}
          </Button>
          <Button size="sm" disabled={!selected} onClick={addToPanel}>
            {t("panel.add.add")}
          </Button>
        </div>
      </div>

      {toast && (
        <div className="absolute bottom-16 left-1/2 z-20 -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-[12px] text-foreground shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
