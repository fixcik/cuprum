import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
import { Select } from "@/components/ui/Select";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Modal } from "@/components/ui/Modal";
import { PanelBlankCanvas } from "@/components/panel/PanelBlankCanvas";
import { BUILTIN_PANEL_PRESETS, COPPER_WEIGHTS, DEFAULT_STACKUP, newPanelDoc, type PanelPreset } from "@/lib/panel";
import { api } from "@/lib/api";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";

/** Inline FR4-blank editor (left params + right schematic canvas). Autosaves on
 *  change (debounced) via savePanelConfig — no Save button. Lives in the Panel
 *  tab; there is no gating, so a fresh project shows defaults and persists on the
 *  first edit. */
export function PanelEditor() {
  const { t } = useTranslation("project");
  const currentPath = useShell((s) => s.currentPath);
  const savePanelConfig = useShell((s) => s.savePanelConfig);
  const userPresets = useSettings((s) => s.panelPresets);
  const addPanelPreset = useSettings((s) => s.addPanelPreset);

  const [width, setWidth] = useState(100);
  const [height, setHeight] = useState(100);
  const [copperWeight, setCopperWeight] = useState(DEFAULT_STACKUP.copper_weight_oz);
  const [substrate, setSubstrate] = useState(DEFAULT_STACKUP.substrate_thickness_mm);
  const [doubleSided, setDoubleSided] = useState(DEFAULT_STACKUP.double_sided);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetName, setPresetName] = useState("");

  // Snapshot of the last-persisted params, so the autosave effect skips writing
  // the just-prefilled values (and skips no-op rewrites).
  // Seed with the initial (default) params so the first autosave pass is a no-op
  // until prefill or a user edit changes something — avoids overwriting stored
  // dimensions if readPanel resolves slower than the debounce.
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

  // Prefill ONCE per project. Read stackup from the store snapshot (not as a hook
  // dep) and dimensions from panel.json; set lastSaved to those values.
  useEffect(() => {
    if (!currentPath || prefilled.current === currentPath) return;
    prefilled.current = currentPath;
    const st = useShell.getState().currentManifest?.stackup;
    const cw = st?.copper_weight_oz ?? DEFAULT_STACKUP.copper_weight_oz;
    const sub = st?.substrate_thickness_mm ?? DEFAULT_STACKUP.substrate_thickness_mm;
    const ds = st?.double_sided ?? DEFAULT_STACKUP.double_sided;
    let cancelled = false;
    const apply = (w: number, h: number) => {
      if (cancelled) return;
      setWidth(w);
      setHeight(h);
      setCopperWeight(cw);
      setSubstrate(sub);
      setDoubleSided(ds);
      lastSaved.current = JSON.stringify({ w, h, cw, sub, ds });
    };
    api
      .readPanel(currentPath)
      .then((p) => apply(p?.width_mm ?? 100, p?.height_mm ?? 100))
      .catch(() => apply(100, 100));
    return () => {
      cancelled = true;
    };
  }, [currentPath]);

  const valid = width > 0 && height > 0 && substrate > 0;

  // Debounced autosave: write only when the params differ from the last-persisted
  // snapshot and are valid.
  useEffect(() => {
    if (!currentPath || !valid) return;
    const key = JSON.stringify({ w: width, h: height, cw: copperWeight, sub: substrate, ds: doubleSided });
    if (key === lastSaved.current) return;
    const id = setTimeout(() => {
      savePanelConfig(newPanelDoc(width, height), {
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

        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("setup.sectionBlank")}
        </div>
        <div className="mb-4 divide-y divide-border/60">
          <label className="flex items-center justify-between gap-4 py-2">
            <span className="text-[12px] text-foreground">{t("setup.width")}</span>
            <div className="flex items-center gap-1.5">
              <TextInput
                type="number"
                step="1"
                inputMode="decimal"
                value={String(width)}
                onChange={(e) => setWidth(parseFloat(e.target.value) || 0)}
                className="w-24 text-right tabular-nums"
              />
              <span className="w-7 text-[11px] text-muted-foreground">mm</span>
            </div>
          </label>
          <label className="flex items-center justify-between gap-4 py-2">
            <span className="text-[12px] text-foreground">{t("setup.height")}</span>
            <div className="flex items-center gap-1.5">
              <TextInput
                type="number"
                step="1"
                inputMode="decimal"
                value={String(height)}
                onChange={(e) => setHeight(parseFloat(e.target.value) || 0)}
                className="w-24 text-right tabular-nums"
              />
              <span className="w-7 text-[11px] text-muted-foreground">mm</span>
            </div>
          </label>
        </div>

        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {t("setup.sectionStackup")}
        </div>
        <div className="divide-y divide-border/60">
          <label className="flex items-center justify-between gap-4 py-2">
            <span className="text-[12px] text-foreground">{t("setup.copperWeight")}</span>
            <Select
              value={String(copperWeight)}
              onChange={(e) => setCopperWeight(parseFloat(e.target.value))}
              className="w-32"
            >
              {COPPER_WEIGHTS.map((w) => (
                <option key={w} value={w}>
                  {w} oz
                </option>
              ))}
            </Select>
          </label>
          <label className="flex items-center justify-between gap-4 py-2">
            <span className="text-[12px] text-foreground">{t("setup.substrate")}</span>
            <div className="flex items-center gap-1.5">
              <TextInput
                type="number"
                step="0.1"
                inputMode="decimal"
                value={String(substrate)}
                onChange={(e) => setSubstrate(parseFloat(e.target.value) || 0)}
                className="w-24 text-right tabular-nums"
              />
              <span className="w-7 text-[11px] text-muted-foreground">mm</span>
            </div>
          </label>
          <div className="flex items-center justify-between gap-4 py-2">
            <span className="text-[12px] text-foreground">{t("setup.sides")}</span>
            <SegmentedControl<"single" | "double">
              value={doubleSided ? "double" : "single"}
              onChange={(v) => setDoubleSided(v === "double")}
              options={[
                { value: "single", label: t("setup.sidesSingle") },
                { value: "double", label: t("setup.sidesDouble") },
              ]}
            />
          </div>
        </div>

        {saveError && <div className="mt-3 text-[11px] text-destructive">{saveError}</div>}
      </div>

      <div className="min-w-0 flex-1">
        <PanelBlankCanvas widthMm={width || 1} heightMm={height || 1} doubleSided={doubleSided} />
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
