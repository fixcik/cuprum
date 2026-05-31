import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
import { Select } from "@/components/ui/Select";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { PanelBlankCanvas } from "@/components/panel/PanelBlankCanvas";
import { BUILTIN_PANEL_PRESETS, COPPER_WEIGHTS, DEFAULT_STACKUP, newPanelDoc, type PanelPreset } from "@/lib/panel";
import { api } from "@/lib/api";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";

export function PanelSetupPage() {
  const { t } = useTranslation("project");
  const currentPath = useShell((s) => s.currentPath);
  const manifest = useShell((s) => s.currentManifest);
  const setView = useShell((s) => s.setView);
  const savePanelConfig = useShell((s) => s.savePanelConfig);
  const userPresets = useSettings((s) => s.panelPresets);
  const addPanelPreset = useSettings((s) => s.addPanelPreset);

  const [width, setWidth] = useState(100);
  const [height, setHeight] = useState(100);
  const [copperWeight, setCopperWeight] = useState(DEFAULT_STACKUP.copper_weight_oz);
  const [substrate, setSubstrate] = useState(DEFAULT_STACKUP.substrate_thickness_mm);
  const [doubleSided, setDoubleSided] = useState(DEFAULT_STACKUP.double_sided);
  const [saving, setSaving] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  // Prefill when re-editing an already-configured blank.
  useEffect(() => {
    let cancelled = false;
    if (!currentPath) return;
    const st = manifest?.stackup;
    if (st) {
      setCopperWeight(st.copper_weight_oz);
      setSubstrate(st.substrate_thickness_mm);
      setDoubleSided(st.double_sided);
    }
    setReadError(null);
    api
      .readPanel(currentPath)
      .then((p) => {
        if (cancelled || !p) return;
        setWidth(p.width_mm);
        setHeight(p.height_mm);
      })
      .catch((e) => {
        // Surface a corrupt/incompatible panel.json instead of silently
        // falling back to defaults (which could overwrite a real config).
        if (!cancelled) setReadError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [currentPath, manifest]);

  const presets: PanelPreset[] = [...BUILTIN_PANEL_PRESETS, ...userPresets];

  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setWidth(p.widthMm);
    setHeight(p.heightMm);
    setCopperWeight(p.stackup.copper_weight_oz);
    setSubstrate(p.stackup.substrate_thickness_mm);
    // Persisted presets predating `double_sided` (no persist-version bump) lack
    // the field; default it so the boolean state never becomes undefined.
    setDoubleSided(p.stackup.double_sided ?? false);
  };

  const savePreset = () => {
    const name = window.prompt(t("setup.presetNamePrompt"));
    if (!name || !name.trim()) return;
    addPanelPreset({
      id: `user-${name.trim()}-${width}x${height}`,
      name: name.trim(),
      widthMm: width,
      heightMm: height,
      stackup: { copper_weight_oz: copperWeight, substrate_thickness_mm: substrate, double_sided: doubleSided },
    });
  };

  const valid = width > 0 && height > 0 && substrate > 0;

  const onSave = async () => {
    if (!currentPath || saving || !valid) return;
    setSaving(true);
    try {
      await savePanelConfig(newPanelDoc(width, height), {
        copper_weight_oz: copperWeight,
        substrate_thickness_mm: substrate,
        double_sided: doubleSided,
      });
      setView("project"); // only navigate on success (savePanelConfig rethrows)
    } catch {
      // error is already surfaced via shell store; stay on the wizard
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setView("project")}>
            <ArrowLeft className="size-4" /> {t("setup.cancel")}
          </Button>
          <h1 className="text-[13px] font-semibold text-foreground">{t("setup.title")}</h1>
        </div>
        <Button onClick={onSave} disabled={!valid || saving}>
          {t("setup.save")}
        </Button>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="w-80 shrink-0 overflow-auto border-r border-border p-4">
          {readError && (
            <div className="mb-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px] text-destructive">
              {readError}
            </div>
          )}

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
              <Button variant="ghost" size="sm" onClick={savePreset}>
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
        </div>

        <div className="min-w-0 flex-1">
          <PanelBlankCanvas widthMm={width || 1} heightMm={height || 1} doubleSided={doubleSided} />
        </div>
      </div>
    </div>
  );
}
