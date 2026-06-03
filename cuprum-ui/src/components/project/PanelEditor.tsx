import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
import { Select } from "@/components/ui/Select";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Modal } from "@/components/ui/Modal";
import { Ruler, Layers } from "lucide-react";
import { SettingsSection } from "@/components/ui/settings/SettingsSection";
import { SettingRow } from "@/components/ui/settings/SettingRow";
import { UnitField } from "@/components/ui/settings/UnitField";
import { PanelBlankCanvas } from "@/components/panel/PanelBlankCanvas";
import { BUILTIN_PANEL_PRESETS, COPPER_WEIGHTS, DEFAULT_STACKUP, newPanelDoc, type PanelPreset } from "@/lib/panel";
import { isOffPanel, clampDeltaToPanel, boxesForInstances } from "@/lib/panelPlacement";
import { usePlacedBoardSizes } from "@/hooks/usePlacedBoardSizes";
import type { BoardInstance } from "@/lib/api";
import { useShell } from "@/shellStore";
import { usePanelSelection } from "@/panelSelectionStore";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";

// Stable empty fallbacks: returning a fresh `[]` from a zustand selector on every
// render triggers an infinite re-render loop, so share one frozen array instead.
const EMPTY_INSTANCES: BoardInstance[] = [];

/** Inline FR4-blank editor (left params + right schematic canvas). Autosaves on
 *  change (debounced) via savePanelConfig — no Save button. Lives in the Panel
 *  tab; there is no gating, so a fresh project shows defaults and persists on the
 *  first edit. */
export function PanelEditor() {
  const { t } = useTranslation("project");
  const { fmtLen } = useUnitFormat();
  const currentPath = useShell((s) => s.currentPath);
  const savePanelConfig = useShell((s) => s.savePanelConfig);
  const docNonce = useShell((s) => s.docNonce);
  const instances = useShell((s) => s.currentManifest?.panel?.instances ?? EMPTY_INSTANCES);
  const userPresets = useSettings((s) => s.panelPresets);
  const addPanelPreset = useSettings((s) => s.addPanelPreset);
  // The panel is bounded by the machine's work area (from Settings): you can't
  // make a blank larger than the machine can expose/process.
  const profile = useSettings((s) => s.profile);
  const maxW = profile.maxPanelWidthMm;
  const maxH = profile.maxPanelHeightMm;

  const [width, setWidth] = useState(100);
  const [height, setHeight] = useState(100);
  const [copperWeight, setCopperWeight] = useState(DEFAULT_STACKUP.copper_weight_oz);
  const [substrate, setSubstrate] = useState(DEFAULT_STACKUP.substrate_thickness_mm);
  const [doubleSided, setDoubleSided] = useState(DEFAULT_STACKUP.double_sided);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Visible side of the blank, owned here so Ctrl+A can scope its selection to it.
  const [side, setSide] = useState<"top" | "bottom">("top");
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  // Board extents (mm) per placed design — shared hook, fetched once per design.
  // Used for the off-panel counter and the keyboard clamp (nudge + duplicate).
  const sizes = usePlacedBoardSizes();

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

  // Exceeding the machine's work area is an advisory hint, NOT a hard limit: flag
  // the field so the user knows it won't fit as-is, but still persist the value —
  // they may raise the work area in Settings later, and the real "board > panel"
  // gate lives in the DFM check. Persistence only needs finite positive numbers.
  const widthTooBig = width > maxW;
  const heightTooBig = height > maxH;
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

  // Count designs poking off the (live-edited) blank. Drives a non-blocking warning
  // so shrinking the panel surfaces the consequence instead of silently hiding it.
  const offPanelCount = useMemo(() => {
    if (!valid) return 0;
    return instances.reduce((n, inst) => {
      const sz = sizes[inst.design_id];
      if (!sz) return n;
      const off = isOffPanel({
        xMm: inst.x_mm,
        yMm: inst.y_mm,
        boardW: sz.w,
        boardH: sz.h,
        rotationDeg: inst.rotation_deg,
        panelW: width,
        panelH: height,
      });
      return off ? n + 1 : n;
    }, 0);
  }, [instances, sizes, width, height, valid]);

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
  // Current visible side, read by the once-bound keydown listener (Ctrl+A scope).
  const sideRef = useRef(side);
  sideRef.current = side;
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
        // Only the visible side is selectable on-canvas; scope Ctrl+A to it so a
        // following Delete can't silently drop hidden back-side instances.
        const side = sideRef.current;
        const ids = (useShell.getState().currentManifest?.panel?.instances ?? [])
          .filter((i) => (i.layer_ref === "Bottom" ? "bottom" : "top") === side)
          .map((i) => i.id);
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

  const presets: PanelPreset[] = [...BUILTIN_PANEL_PRESETS, ...userPresets];

  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setWidth(p.widthMm);
    setHeight(p.heightMm);
    setCopperWeight(p.stackup.copper_weight_oz);
    setSubstrate(p.stackup.substrate_thickness_mm);
    setDoubleSided(p.stackup.double_sided ?? false);
  };

  const confirmSavePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    addPanelPreset({
      id: `user-${name}-${width}x${height}`,
      name,
      widthMm: width,
      heightMm: height,
      stackup: { copper_weight_oz: copperWeight, substrate_thickness_mm: substrate, double_sided: doubleSided },
    });
    setPresetOpen(false);
    setPresetName("");
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="w-80 shrink-0 overflow-auto border-r border-border p-4">
        <div className="mb-4">
          <label className="mb-1 block text-[11px] text-muted-foreground">{t("setup.preset")}</label>
          <div className="flex gap-2">
            <Select defaultValue="" onChange={(e) => applyPreset(e.target.value)} className="min-w-0 flex-1">
              <option value="" disabled>
                {t("setup.loadPreset")}
              </option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Button variant="ghost" size="sm" onClick={() => setPresetOpen(true)}>
              {t("setup.savePreset")}
            </Button>
          </div>
        </div>

        <SettingsSection icon={Ruler} title={t("setup.sectionBlank")}>
          <SettingRow label={t("setup.width")}>
            <UnitField value={width} onChange={setWidth} dim="coarse" step="1" invalid={widthTooBig} />
          </SettingRow>
          <SettingRow label={t("setup.height")}>
            <UnitField value={height} onChange={setHeight} dim="coarse" step="1" invalid={heightTooBig} />
          </SettingRow>
          <p className={`px-1 text-[11px] ${widthTooBig || heightTooBig ? "text-destructive" : "text-muted-foreground"}`}>
            {t("setup.maxFromSettings", { w: fmtLen(maxW), h: fmtLen(maxH) })}
          </p>
          {offPanelCount > 0 && (
            <p className="px-1 text-[11px] text-warning">
              {t("setup.offPanelWarning", { count: offPanelCount })}
            </p>
          )}
        </SettingsSection>

        <SettingsSection icon={Layers} title={t("setup.sectionStackup")}>
          <SettingRow label={t("setup.copperWeight")}>
            <Select
              value={String(copperWeight)}
              onChange={(e) => setCopperWeight(parseFloat(e.target.value))}
              className="w-28"
            >
              {COPPER_WEIGHTS.map((w) => (
                <option key={w} value={w}>
                  {w} oz
                </option>
              ))}
            </Select>
          </SettingRow>
          <SettingRow label={t("setup.substrate")}>
            <UnitField value={substrate} onChange={setSubstrate} dim="fine" step="0.1" />
          </SettingRow>
          <SettingRow label={t("setup.sides")}>
            <SegmentedControl<"single" | "double">
              value={doubleSided ? "double" : "single"}
              onChange={(v) => setDoubleSided(v === "double")}
              options={[
                { value: "single", label: t("setup.sidesSingle") },
                { value: "double", label: t("setup.sidesDouble") },
              ]}
            />
          </SettingRow>
        </SettingsSection>

        {saveError && <div className="mt-3 text-[11px] text-destructive">{saveError}</div>}
      </div>

      <div className="min-w-0 flex-1">
        <PanelBlankCanvas widthMm={width || 1} heightMm={height || 1} doubleSided={doubleSided} side={side} onSideChange={setSide} />
      </div>

      <Modal
        open={presetOpen}
        onClose={() => setPresetOpen(false)}
        title={t("setup.presetModalTitle")}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setPresetOpen(false)}>
              {t("settings.cancel")}
            </Button>
            <Button size="sm" disabled={!presetName.trim()} onClick={confirmSavePreset}>
              {t("settings.save")}
            </Button>
          </>
        }
      >
        <TextInput
          autoFocus
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
          placeholder={t("setup.presetNamePlaceholder")}
          className="w-full"
          onKeyDown={(e) => {
            if (e.key === "Enter") confirmSavePreset();
          }}
        />
      </Modal>
    </div>
  );
}
