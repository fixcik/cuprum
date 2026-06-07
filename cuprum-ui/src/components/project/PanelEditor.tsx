import { useEffect, useMemo, useRef, useState } from "react";
import { PanelBlankCanvas } from "@/components/panel/PanelBlankCanvas";
import { PanelInspector } from "@/components/project/PanelInspector";
import {
  BUILTIN_PANEL_PRESETS,
  DEFAULT_STACKUP,
  newPanelDoc,
  panelPresetId,
  panelPresetLabel,
  type PanelPreset,
} from "@/lib/panel";
import { clampDeltaToPanel, boxesForInstances } from "@/lib/panelPlacement";
import { usePanelFindings } from "@/hooks/usePanelFindings";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";
import { useReportPanelVerdict } from "@/hooks/useReportPanelVerdict";
import { useShell } from "@/shellStore";
import { usePanelSelection } from "@/panelSelectionStore";
import { useSettings } from "@/settingsStore";

/** Inline FR4-blank editor (left params + right schematic canvas). Autosaves on
 *  change (debounced) via savePanelConfig — no Save button. Lives in the Panel
 *  tab; there is no gating, so a fresh project shows defaults and persists on the
 *  first edit. */
export function PanelEditor() {
  const currentPath = useShell((s) => s.currentPath);
  const savePanelConfig = useShell((s) => s.savePanelConfig);
  const docNonce = useShell((s) => s.docNonce);
  const userPresets = useSettings((s) => s.panelPresets);
  const addPanelPreset = useSettings((s) => s.addPanelPreset);
  const removePanelPreset = useSettings((s) => s.removePanelPreset);
  const hiddenPresetIds = useSettings((s) => s.hiddenPanelPresetIds);
  const hidePanelPreset = useSettings((s) => s.hidePanelPreset);
  const profile = useSettings((s) => s.profile);

  const [width, setWidth] = useState(100);
  const [height, setHeight] = useState(100);
  const [copperWeight, setCopperWeight] = useState(DEFAULT_STACKUP.copper_weight_oz);
  const [substrate, setSubstrate] = useState(DEFAULT_STACKUP.substrate_thickness_mm);
  const [doubleSided, setDoubleSided] = useState(DEFAULT_STACKUP.double_sided);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Board extents (mm) per placed design — shared hook, fetched once per design.
  // Used for the keyboard clamp (nudge + duplicate).
  const sizes = usePlacedBoardSizes();
  // Panel-level findings — single source for the off-panel count shown in the inspector.
  const { findings: panelFindings, verdict, ready } = usePanelFindings();
  // Persist the panel verdict to the recents catalog (debounced, only when ready).
  useReportPanelVerdict(verdict, ready, profile);

  // Snapshot of the last-persisted params, so the autosave effect skips writing
  // the just-prefilled values (and skips no-op rewrites). Seed with the initial
  // (default) params so the first autosave pass is a no-op until prefill or a user
  // edit changes something.
  const lastSaved = useRef(
    JSON.stringify({
      w: 100,
      h: 100,
      cw: DEFAULT_STACKUP.copper_weight_oz,
      sub: DEFAULT_STACKUP.substrate_thickness_mm,
      ds: DEFAULT_STACKUP.double_sided,
    }),
  );
  const prefilled = useRef<string | null>(null);

  // Re-prefill on project change AND whenever the document is replaced wholesale
  // (undo/redo/restore bump docNonce). The key folds both so a no-op render skips.
  const prefilledKey = `${currentPath ?? ""}#${docNonce}`;
  useEffect(() => {
    if (!currentPath || prefilled.current === prefilledKey) return;
    const m = useShell.getState().currentManifest;
    const st = m?.stackup;
    const cw = st?.copper_weight_oz ?? DEFAULT_STACKUP.copper_weight_oz;
    const sub = st?.substrate_thickness_mm ?? DEFAULT_STACKUP.substrate_thickness_mm;
    const ds = st?.double_sided ?? DEFAULT_STACKUP.double_sided;
    const w = m?.panel?.width_mm ?? 100;
    const h = m?.panel?.height_mm ?? 100;
    setWidth(w);
    setHeight(h);
    setCopperWeight(cw);
    setSubstrate(sub);
    setDoubleSided(ds);
    lastSaved.current = JSON.stringify({ w, h, cw, sub, ds });
    prefilled.current = prefilledKey;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, docNonce]);

  const valid = width > 0 && height > 0 && substrate > 0;

  // Debounced autosave: write only when the params differ from the last-persisted
  // snapshot and are valid.
  useEffect(() => {
    if (!currentPath || !valid) return;
    const key = JSON.stringify({ w: width, h: height, cw: copperWeight, sub: substrate, ds: doubleSided });
    if (key === lastSaved.current) return;
    const id = setTimeout(() => {
      // Editing the blank's size/stackup must NOT wipe the layout: carry over the
      // existing instances + tooling holes. Read the panel fresh here (not from the
      // effect closure) so a concurrent add isn't clobbered. Falls back to a new
      // doc only when none exists yet.
      const prevPanel = useShell.getState().currentManifest?.panel;
      const nextPanel = prevPanel
        ? { ...prevPanel, width_mm: width, height_mm: height }
        : newPanelDoc(width, height);
      savePanelConfig(nextPanel, {
        copper_weight_oz: copperWeight,
        substrate_thickness_mm: substrate,
        double_sided: doubleSided,
      })
        .then(() => {
          lastSaved.current = key;
          setSaveError(null);
        })
        .catch((e) => setSaveError(String(e)));
    }, 500);
    return () => clearTimeout(id);
  }, [currentPath, width, height, copperWeight, substrate, doubleSided, valid, savePanelConfig]);

  // Count boards that are off the panel — derived from the single findings source
  // (evaluatePanel) so all off-panel logic lives in one place.
  const offPanelCount = useMemo(() => {
    const f = panelFindings.find((x) => x.category === "off-panel");
    return f ? f.instanceIds.length : 0;
  }, [panelFindings]);

  // Clear the ephemeral selection whenever the project path or the document
  // identity changes (open/close, undo/redo/restore) — stale ids must not linger.
  useEffect(() => {
    usePanelSelection.getState().clear();
  }, [currentPath, docNonce]);

  // Panel editor hotkeys: Delete/Backspace removes, Esc clears, Ctrl/Cmd+A selects
  // all, Ctrl/Cmd+D duplicates, arrows nudge (Shift = 10 mm). Ignored when typing in
  // a field. Bound once;
  // panel dims are read via refs so the listener needn't re-bind on every edit.
  const panelDims = useRef({ w: width, h: height });
  panelDims.current = { w: width, h: height };
  // Sizes ref so the keydown listener (bound once) always reads the current map.
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const sel = [...usePanelSelection.getState().selected];
      if (e.key === "Delete" || e.key === "Backspace") {
        if (sel.length) {
          e.preventDefault();
          void useShell.getState().removeInstances(sel);
          usePanelSelection.getState().clear();
        }
      } else if (e.key === "Escape") {
        usePanelSelection.getState().clear();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        // Placements are side-agnostic — Ctrl+A selects every instance.
        const ids = (useShell.getState().currentManifest?.panel?.instances ?? []).map((i) => i.id);
        usePanelSelection.getState().set(ids);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        if (!sel.length) return;
        e.preventDefault();
        // Duplicate the selection with a precise rotated-AABB clamped offset so
        // copies land inside the panel even when instances are rotated.
        const placed = useShell.getState().currentManifest?.panel?.instances ?? [];
        const selSet = new Set(sel);
        const picked = placed.filter((i) => selSet.has(i.id));
        const { w: panelW, h: panelH } = panelDims.current;
        const { dx, dy } = clampDeltaToPanel(boxesForInstances(picked, sizesRef.current), 2, 2, panelW, panelH);
        void useShell.getState().duplicateInstances(sel, dx, dy).then((ids) => usePanelSelection.getState().set(ids));
      } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
        if (!sel.length) return;
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx0 = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy0 = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        // Precise rotated-AABB clamp: same geometry as the drag path.
        const { w: panelW, h: panelH } = panelDims.current;
        const placed = useShell.getState().currentManifest?.panel?.instances ?? [];
        const selSet = new Set(sel);
        const picked = placed.filter((i) => selSet.has(i.id));
        const { dx: cdx, dy: cdy } = clampDeltaToPanel(boxesForInstances(picked, sizesRef.current), dx0, dy0, panelW, panelH);
        void useShell.getState().moveInstances(sel, cdx, cdy);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const rotate = () => {
    setWidth(height);
    setHeight(width);
  };

  // Built-ins minus the ones the user dismissed, then user presets. Hiding a
  // built-in is how built-ins become deletable.
  const presets: PanelPreset[] = [
    ...BUILTIN_PANEL_PRESETS.filter((p) => !hiddenPresetIds.includes(p.id)),
    ...userPresets,
  ];

  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setWidth(p.widthMm);
    setHeight(p.heightMm);
    setCopperWeight(p.stackup.copper_weight_oz);
    setSubstrate(p.stackup.substrate_thickness_mm);
    setDoubleSided(p.stackup.double_sided ?? false);
  };

  // Save the current blank as a preset — name and id are derived from the params,
  // so there is no name prompt and re-saving the same blank updates in place.
  // No-op if a visible preset (built-in or user) already matches these params, so
  // Save can't spawn a duplicate chip of an existing built-in.
  const savePreset = () => {
    const stackup = { copper_weight_oz: copperWeight, substrate_thickness_mm: substrate, double_sided: doubleSided };
    const already = presets.some(
      (p) =>
        p.widthMm === width &&
        p.heightMm === height &&
        p.stackup.copper_weight_oz === copperWeight &&
        p.stackup.substrate_thickness_mm === substrate &&
        (p.stackup.double_sided ?? false) === doubleSided,
    );
    if (already) return;
    addPanelPreset({
      id: panelPresetId(width, height, stackup),
      name: panelPresetLabel(width, height, stackup),
      widthMm: width,
      heightMm: height,
      stackup,
    });
  };

  // Delete a preset: user presets are removed outright; built-ins can't be
  // removed, so dismissing one hides it from the chip list.
  const deletePreset = (id: string) => {
    if (id.startsWith("builtin-")) hidePanelPreset(id);
    else removePanelPreset(id);
  };

  return (
    <div className="flex h-full min-h-0">
      {/* Canvas is the hero now */}
      <div className="relative min-w-0 flex-1">
        <PanelBlankCanvas widthMm={width || 1} heightMm={height || 1} />
        {saveError && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-destructive/90 px-3 py-1.5 text-[11px] text-destructive-foreground shadow-md">
            {saveError}
          </div>
        )}
      </div>

      <PanelInspector
        width={width}
        height={height}
        copperWeight={copperWeight}
        substrate={substrate}
        doubleSided={doubleSided}
        setWidth={setWidth}
        setHeight={setHeight}
        setCopperWeight={setCopperWeight}
        setSubstrate={setSubstrate}
        setDoubleSided={setDoubleSided}
        offPanelCount={offPanelCount}
        presets={presets}
        onApplyPreset={applyPreset}
        onSavePreset={savePreset}
        onDeletePreset={deletePreset}
        onRotate={rotate}
      />
    </div>
  );
}
