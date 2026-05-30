import * as React from "react";
import { RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
import { Switch } from "@/components/ui/Switch";
import { HelpTip } from "@/components/ui/HelpTip";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { Diagrams } from "@/components/settings/diagrams";
import { useSettings } from "@/settingsStore";
import { type Language, type Units } from "@/settingsStore";
import type { CapabilityProfile } from "@/lib/capabilityProfile";
import { useUnitFormat, type Dim } from "@/i18n/useUnitFormat";

/** Label cell: text + optional inline hint + an optional "?" help tooltip. */
function FieldLabel({ label, hint, help, helpImage }: { label: string; hint?: string; help?: string; helpImage?: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-foreground">
      {label}
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      {help && <HelpTip text={help} image={helpImage} />}
    </span>
  );
}

/** A labelled numeric field that commits any valid number live. Supports unit conversion via dim. */
function NumberField({
  label,
  value,
  onChange,
  step = "0.01",
  dim,
  suffix,
  hint,
  help,
  helpImage,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  step?: string;
  dim?: Dim;
  suffix?: string;
  hint?: string;
  help?: string;
  helpImage?: React.ReactNode;
}) {
  const { units, toDisplay, fromDisplay, unitLabel } = useUnitFormat();
  const shown = dim ? toDisplay(value, dim) : value;
  const [text, setText] = React.useState(String(shown));
  React.useEffect(() => setText(String(dim ? toDisplay(value, dim) : value)), [value, dim, toDisplay]);
  // In imperial, mm-tuned steps are too coarse/fine; pick a sensible per-unit step.
  const effStep = !dim || units !== "imperial" ? step : dim === "coarse" ? "0.001" : "0.1";
  const suffixText = dim ? unitLabel(dim) : (suffix ?? "");
  return (
    <label className="flex items-center justify-between gap-4 py-2">
      <FieldLabel label={label} hint={hint} help={help} helpImage={helpImage} />
      <div className="flex shrink-0 items-center gap-1.5">
        <TextInput
          type="number"
          step={effStep}
          inputMode="decimal"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) onChange(dim ? fromDisplay(v, dim) : v);
          }}
          className="w-24 text-right tabular-nums"
        />
        <span className="w-7 text-[11px] text-muted-foreground">{suffixText}</span>
      </div>
    </label>
  );
}

function BoolField({
  label,
  value,
  onChange,
  help,
  helpImage,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
  help?: string;
  helpImage?: React.ReactNode;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-2">
      <FieldLabel label={label} help={help} helpImage={helpImage} />
      <Switch checked={value} onCheckedChange={onChange} />
    </label>
  );
}

/** Edits a numeric array as a comma/space-separated list (the drill bit set). Always dim="fine". */
function ArrayField({
  label,
  value,
  onChange,
  hint,
  help,
}: {
  label: string;
  value: number[];
  onChange: (v: number[]) => void;
  hint?: string;
  help?: string;
}) {
  const { toDisplay, fromDisplay, unitLabel } = useUnitFormat();
  const fmt = (arr: number[]) => arr.map((mm) => +toDisplay(mm, "fine").toFixed(3)).join(" ");
  const [text, setText] = React.useState(fmt(value));
  // Resync on value AND unit change: toDisplay's identity changes with the units
  // setting, so depending on it re-renders the field in the active unit.
  React.useEffect(() => setText(fmt(value)), [value, toDisplay]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <label className="flex items-center justify-between gap-4 py-2">
      <FieldLabel label={label} hint={hint ? `${hint}, ${unitLabel("fine")}` : unitLabel("fine")} help={help} />
      <TextInput
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // Split on whitespace/semicolons only — never the comma, which is the
          // decimal separator in many locales (e.g. "0,25 0,35"). A comma inside
          // a token is normalized to a dot before parsing.
          const arr = e.target.value
            .split(/[\s;]+/)
            .map((s) => parseFloat(s.replace(",", ".")))
            .filter((x) => !Number.isNaN(x) && x > 0)
            .map((v) => fromDisplay(v, "fine"))
            .sort((a, b) => a - b);
          if (arr.length) onChange(arr);
        }}
        className="w-48 text-right text-[11px] tabular-nums"
      />
    </label>
  );
}

type Tab = "general" | "capabilities";
const TABS: Tab[] = ["general", "capabilities"];
type CapCategoryId = "panel" | "copper" | "drill" | "maskSilk";
const CAP_CATEGORIES: CapCategoryId[] = ["panel", "copper", "drill", "maskSilk"];

export function SettingsPage() {
  const { t } = useTranslation("settings");
  const { t: tc } = useTranslation("common");
  const profile = useSettings((s) => s.profile);
  const setProfile = useSettings((s) => s.setProfile);
  const resetProfile = useSettings((s) => s.resetProfile);
  const set = <K extends keyof CapabilityProfile>(k: K) => (v: CapabilityProfile[K]) => setProfile({ [k]: v });
  const language = useSettings((s) => s.language);
  const setLanguage = useSettings((s) => s.setLanguage);
  const units = useSettings((s) => s.units);
  const setUnits = useSettings((s) => s.setUnits);
  const [tab, setTab] = React.useState<Tab>("general");
  const [active, setActive] = React.useState<CapCategoryId>("panel");

  // App version, compiled into the bundle from tauri.conf.json by the release
  // pipeline and read back at runtime.
  const [version, setVersion] = React.useState<string | null>(null);
  React.useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(null));
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Single header row: tabs on the left, the contextual action on the right.
       *  No separate title row — the active tab already names the section. */}
      <div className="flex items-center justify-between border-b border-border px-3">
        <div className="flex items-center gap-1">
          {TABS.map((tb) => (
            <button
              key={tb}
              type="button"
              onClick={() => setTab(tb)}
              className={`relative px-3 py-2.5 text-[12px] transition-colors ${
                tab === tb ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(`tab.${tb}`)}
              {tab === tb && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary" />}
            </button>
          ))}
        </div>
        {tab === "capabilities" && (
          <Button variant="ghost" onClick={resetProfile} title={t("resetTitle")}>
            <RotateCcw className="size-4" /> {t("reset")}
          </Button>
        )}
      </div>

      {tab === "general" && (
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-xl divide-y divide-border/60 p-6">
            <label className="flex items-center justify-between gap-4 py-2">
              <span className="text-[12px] text-foreground">{t("interface.language")}</span>
              <SegmentedControl<Language>
                value={language}
                onChange={setLanguage}
                options={[
                  { value: "auto", label: t("interface.languageAuto") },
                  { value: "ru", label: "Русский" },
                  { value: "en", label: "English" },
                ]}
              />
            </label>
            <label className="flex items-center justify-between gap-4 py-2">
              <span className="text-[12px] text-foreground">{t("interface.units")}</span>
              <SegmentedControl<Units>
                value={units}
                onChange={setUnits}
                options={[
                  { value: "mm", label: t("interface.unitsMetric") },
                  { value: "imperial", label: t("interface.unitsImperial") },
                ]}
              />
            </label>
            <div className="flex items-center justify-between gap-4 py-2">
              <span className="text-[12px] text-foreground">{t("interface.version")}</span>
              <span className="text-[12px] tabular-nums text-muted-foreground">
                {version ? `v${version}` : "—"}
              </span>
            </div>
          </div>
        </div>
      )}

      {tab === "capabilities" && (
      <div className="flex min-h-0 flex-1">
        {/* Capability sub-categories. */}
        <nav className="w-52 shrink-0 border-r border-border bg-panel p-2">
          {CAP_CATEGORIES.map((id) => (
            <button
              key={id}
              type="button"
              onClick={() => setActive(id)}
              className={`mb-0.5 w-full rounded-md px-3 py-2 text-left text-[12px] transition-colors ${
                active === id ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              }`}
            >
              {t(`category.${id}`)}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto max-w-xl p-6">
            <p className="mb-3 text-[11px] text-muted-foreground">{t("subtitle")}</p>
            <div className="divide-y divide-border/60">
            {active === "panel" && (
              <>
                <NumberField
                  label={t("field.maxPanelWidth.label")}
                  value={profile.maxPanelWidthMm}
                  onChange={set("maxPanelWidthMm")}
                  dim="coarse"
                  help={t("field.maxPanelWidth.help")}
                  helpImage={Diagrams.panelSize}
                />
                <NumberField
                  label={t("field.maxPanelHeight.label")}
                  value={profile.maxPanelHeightMm}
                  onChange={set("maxPanelHeightMm")}
                  dim="coarse"
                  help={t("field.maxPanelHeight.help")}
                  helpImage={Diagrams.panelSize}
                />
                <BoolField
                  label={t("field.allowRotate.label")}
                  value={profile.allowRotateToFit}
                  onChange={set("allowRotateToFit")}
                  help={t("field.allowRotate.help")}
                />
              </>
            )}

            {active === "copper" && (
              <>
                <NumberField
                  label={t("field.maxCopperLayers.label")}
                  value={profile.maxCopperLayers}
                  onChange={set("maxCopperLayers")}
                  step="1"
                  suffix={tc("pcs")}
                  help={t("field.maxCopperLayers.help")}
                />
                <BoolField
                  label={t("field.allowInner.label")}
                  value={profile.allowInnerLayers}
                  onChange={set("allowInnerLayers")}
                  help={t("field.allowInner.help")}
                />
                <NumberField
                  label={t("field.minTrace.label")}
                  value={profile.minTraceMm}
                  onChange={set("minTraceMm")}
                  dim="fine"
                  help={t("field.minTrace.help")}
                  helpImage={Diagrams.traceWidth}
                />
                <NumberField
                  label={t("field.minSpace.label")}
                  value={profile.minSpaceMm}
                  onChange={set("minSpaceMm")}
                  dim="fine"
                  help={t("field.minSpace.help")}
                  helpImage={Diagrams.clearance}
                />
                <NumberField
                  label={t("field.ignoreBelow.label")}
                  value={profile.ignoreBelowMm}
                  onChange={set("ignoreBelowMm")}
                  dim="fine"
                  help={t("field.ignoreBelow.help")}
                />
              </>
            )}

            {active === "drill" && (
              <>
                <NumberField
                  label={t("field.minDrill.label")}
                  value={profile.minDrillMm}
                  onChange={set("minDrillMm")}
                  dim="fine"
                  help={t("field.minDrill.help")}
                  helpImage={Diagrams.drill}
                />
                <ArrayField
                  label={t("field.drillBitSet.label")}
                  value={profile.drillBitSetMm}
                  onChange={set("drillBitSetMm")}
                  hint={t("field.drillBitSet.hint")}
                  help={t("field.drillBitSet.help")}
                />
                <NumberField
                  label={t("field.drillBitTolerance.label")}
                  value={profile.drillBitToleranceMm}
                  onChange={set("drillBitToleranceMm")}
                  dim="fine"
                  help={t("field.drillBitTolerance.help")}
                />
                <NumberField
                  label={t("field.minAnnular.label")}
                  value={profile.minAnnularRingMm}
                  onChange={set("minAnnularRingMm")}
                  dim="fine"
                  help={t("field.minAnnular.help")}
                  helpImage={Diagrams.annular}
                />
                <BoolField
                  label={t("field.viaPlating.label")}
                  value={profile.viaPlatingAvailable}
                  onChange={set("viaPlatingAvailable")}
                  help={t("field.viaPlating.help")}
                />
                <NumberField
                  label={t("field.viaMaxDiameter.label")}
                  value={profile.viaMaxDiameterMm}
                  onChange={set("viaMaxDiameterMm")}
                  dim="fine"
                  hint={t("field.viaMaxDiameter.hint")}
                  help={t("field.viaMaxDiameter.help")}
                />
                <NumberField
                  label={t("field.viaWarn.label")}
                  value={profile.viaWarnCount}
                  onChange={set("viaWarnCount")}
                  step="1"
                  suffix={tc("pcs")}
                  help={t("field.viaWarn.help")}
                />
                <NumberField
                  label={t("field.viaBlock.label")}
                  value={profile.viaBlockCount}
                  onChange={set("viaBlockCount")}
                  step="1"
                  suffix={tc("pcs")}
                  help={t("field.viaBlock.help")}
                />
              </>
            )}

            {active === "maskSilk" && (
              <>
                <NumberField
                  label={t("field.minMaskDam.label")}
                  value={profile.minMaskDamMm}
                  onChange={set("minMaskDamMm")}
                  dim="fine"
                  help={t("field.minMaskDam.help")}
                  helpImage={Diagrams.maskDam}
                />
                <NumberField
                  label={t("field.minSilkLine.label")}
                  value={profile.minSilkLineMm}
                  onChange={set("minSilkLineMm")}
                  dim="fine"
                  help={t("field.minSilkLine.help")}
                  helpImage={Diagrams.silkLine}
                />
                <NumberField
                  label={t("field.maxOvershoot.label")}
                  value={profile.maxOvershootMm}
                  onChange={set("maxOvershootMm")}
                  dim="fine"
                  help={t("field.maxOvershoot.help")}
                  helpImage={Diagrams.overshoot}
                />
              </>
            )}
            </div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
