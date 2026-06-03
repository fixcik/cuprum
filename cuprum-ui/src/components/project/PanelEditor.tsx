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
import { isOffPanel } from "@/lib/panelPlacement";
import { api } from "@/lib/api";
import type { BoardInstance, ProjectDesign } from "@/lib/api";
import { useShell } from "@/shellStore";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";

// Stable empty fallbacks: returning a fresh `[]` from a zustand selector on every
// render triggers an infinite re-render loop, so share one frozen array instead.
const EMPTY_INSTANCES: BoardInstance[] = [];
const EMPTY_DESIGNS: ProjectDesign[] = [];

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
  const workingDir = useShell((s) => s.workingDir);
  const instances = useShell((s) => s.currentManifest?.panel?.instances ?? EMPTY_INSTANCES);
  const designs = useShell((s) => s.currentManifest?.designs ?? EMPTY_DESIGNS);
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
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  // Board extents (mm) per placed design, from cached metrics — used only to warn
  // when shrinking the blank leaves a design hanging off the edge.
  const [boardSizes, setBoardSizes] = useState<Record<string, { w: number; h: number }>>({});

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

  // Fetch board extents for every placed design (cached metrics, cheap). Keyed by
  // design_id; only refetched when the set of placed designs changes.
  useEffect(() => {
    if (!workingDir || instances.length === 0) {
      setBoardSizes((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    let cancelled = false;
    const ids = Array.from(new Set(instances.map((i) => i.design_id)));
    void Promise.all(
      ids.map(async (id) => {
        const d = designs.find((x) => x.id === id);
        if (!d) return null;
        try {
          const refs = d.gerbers.map((g) => ({ rel: g.path, layerType: g.layer_type }));
          const m = await api.projectBoardMetrics(workingDir, refs);
          return [id, { w: m.metrics.board.widthMm, h: m.metrics.board.heightMm }] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setBoardSizes(Object.fromEntries(entries.filter((e): e is NonNullable<typeof e> => e !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [workingDir, instances, designs]);

  // Count designs poking off the (live-edited) blank. Drives a non-blocking warning
  // so shrinking the panel surfaces the consequence instead of silently hiding it.
  const offPanelCount = useMemo(() => {
    if (!valid) return 0;
    return instances.reduce((n, inst) => {
      const sz = boardSizes[inst.design_id];
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
  }, [instances, boardSizes, width, height, valid]);

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
