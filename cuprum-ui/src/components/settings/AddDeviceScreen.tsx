import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Check, Cpu, Plus, Printer } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useSettings } from "@/settingsStore";
import { Button } from "@/components/ui/Button";
import { TextInput } from "@/components/ui/TextInput";
import { presetsForKind, type Machine, type MachinePreset } from "@/lib/machine";

/** Add-device screen: pick a kind + model preset, name it, and create the machine.
 *  Selecting a type resets the chosen preset and name; selecting a non-custom
 *  preset fills the name from its label. On Add we build via the preset, override
 *  the name with the trimmed input, persist, then hand the machine to the parent
 *  so it selects it and returns to the list. */
export function AddDeviceScreen({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (m: Machine) => void;
}) {
  const { t } = useTranslation("settings");
  const addMachine = useSettings((s) => s.addMachine);

  const [kind, setKind] = useState<Machine["kind"] | null>(null);
  const [presetId, setPresetId] = useState<string | null>(null);
  const [name, setName] = useState("");
  // Guard against a rapid double-click / double-Enter creating two machines: a ref
  // flips synchronously within the same tick, before any state re-render lands.
  const submittingRef = useRef(false);

  const presets = kind ? presetsForKind(kind) : [];
  const preset = presets.find((p) => p.id === presetId) ?? null;
  const canSubmit = kind !== null && preset !== null && name.trim().length > 0;

  const pickKind = (next: Machine["kind"]) => {
    if (next === kind) return;
    setKind(next);
    setPresetId(null);
    setName("");
  };

  const pickPreset = (p: MachinePreset) => {
    setPresetId(p.id);
    // Non-custom presets seed the name with the model label; "Своя" leaves it blank.
    setName(p.custom ? "" : p.label);
  };

  const submit = () => {
    if (!preset || submittingRef.current) return;
    submittingRef.current = true;
    // Read the live list so concurrent adds in another window don't collide on id.
    const m = { ...preset.build(useSettings.getState().machines), name: name.trim() };
    addMachine(m);
    onCreated(m);
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto p-8">
      <div className="mx-auto w-full max-w-[560px]">
        <button
          type="button"
          onClick={onCancel}
          className="mb-6 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> {t("equipment.add.back")}
        </button>

        <h2 className="text-[22px] font-semibold text-foreground">{t("equipment.add.title")}</h2>
        <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
          {t("equipment.add.subtitle")}
        </p>

        {/* Type */}
        <div className="mt-6">
          <SectionLabel>{t("equipment.add.type")}</SectionLabel>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <TypeCard
              icon={Cpu}
              label={t("equipment.type.cnc")}
              sub={t("equipment.add.typeCncSub")}
              selected={kind === "cnc"}
              onClick={() => pickKind("cnc")}
            />
            <TypeCard
              icon={Printer}
              label={t("equipment.type.uvlcd")}
              sub={t("equipment.add.typeUvSub")}
              selected={kind === "uvlcd"}
              onClick={() => pickKind("uvlcd")}
            />
          </div>
        </div>

        {/* Model */}
        {kind && (
          <div className="mt-5">
            <SectionLabel>{t("equipment.add.model")}</SectionLabel>
            <div className="mt-2 grid grid-cols-2 gap-3">
              {presets.map((p) => (
                <PresetCard
                  key={p.id}
                  // Custom presets show a localized "Своя / настроить вручную"
                  // heading rather than a model name (which would collide with the
                  // first real preset, e.g. both showing "CNC 3018").
                  label={p.custom ? t("equipment.add.customLabel") : p.label}
                  sub={p.custom ? t("equipment.add.customSub") : p.sub}
                  selected={presetId === p.id}
                  onClick={() => pickPreset(p)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Name */}
        {kind && (
          <div className="mt-5">
            <SectionLabel>{t("equipment.add.name")}</SectionLabel>
            <TextInput
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("equipment.add.namePlaceholder")}
              className="mt-2 h-10 rounded-lg text-[13px]"
            />
          </div>
        )}

        {/* Footer */}
        <div className="mt-7 flex items-center justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            {t("equipment.add.cancel")}
          </Button>
          <Button onClick={submit} disabled={!canSubmit || submittingRef.current}>
            <Plus className="size-4" /> {t("equipment.add.submit")}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Section label above each group ("ТИП", "МОДЕЛЬ", "НАЗВАНИЕ"). */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}

/** A device-type selection card (CNC / UV LCD) with an icon plate. */
function TypeCard({
  icon: Icon,
  label,
  sub,
  selected,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  sub: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors ${
        selected
          ? "border-primary/60 bg-primary/10"
          : "border-border bg-card/40 hover:border-border hover:bg-foreground/5"
      }`}
    >
      <span
        className={`grid size-10 shrink-0 place-items-center rounded-lg transition-colors ${
          selected ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground"
        }`}
      >
        <Icon className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-foreground">{label}</span>
        <span className="block text-[12px] leading-snug text-muted-foreground">{sub}</span>
      </span>
    </button>
  );
}

/** A model-preset selection card with a check when selected. */
function PresetCard({
  label,
  sub,
  selected,
  onClick,
}: {
  label: string;
  sub: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-xl border px-3.5 py-3 text-left transition-colors ${
        selected
          ? "border-primary/60 bg-primary/10"
          : "border-border bg-card/40 hover:border-border hover:bg-foreground/5"
      }`}
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-semibold text-foreground">{label}</span>
        <span className="block truncate text-[12px] tabular-nums text-muted-foreground">{sub}</span>
      </span>
      {selected && <Check className="size-4 shrink-0 text-primary" />}
    </button>
  );
}
