import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { HelpTip } from "@/components/ui/HelpTip";
import { Switch } from "@/components/ui/Switch";
import { NumberInput } from "@/components/settings/fields";
import { decodeMask, encodeMask, validate, type GrblSettingDef } from "@/lib/grblSettings";

/** One GRBL setting row. `def` is undefined for settings not in the catalog
 *  (rendered raw). `value` is the current raw value (draft ?? baseline); `dirty`
 *  marks it changed from baseline. Emits the new raw value via `onChange`. */
export function GrblSettingField({
  n,
  def,
  value,
  dirty,
  onChange,
}: {
  n: number;
  def?: GrblSettingDef;
  value: string;
  dirty: boolean;
  onChange: (raw: string) => void;
}) {
  const { t } = useTranslation("grbl");

  // Unknown setting: raw text field, no help (no catalog description).
  if (!def) {
    return (
      <div className="flex items-center justify-between gap-3 py-2">
        <span className={`text-[13px] ${dirty ? "text-primary" : "text-foreground/90"}`}>${n}</span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-9 w-24 rounded-md border border-input bg-[hsl(var(--input)/0.25)] px-3 text-right text-[13px] tabular-nums text-foreground outline-none focus-visible:border-muted-foreground/60"
        />
      </div>
    );
  }

  const label = t(`setting.${def.key}.label`);
  const help = t(`setting.${def.key}.desc`);
  const left = (
    <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-tight text-foreground/90">
      <span className="text-balance">
        <span className="text-muted-foreground/60">${def.n}</span> {label}
      </span>
      <HelpTip text={help} />
      {def.critical && (
        <AlertTriangle className="size-3.5 shrink-0 text-amber-500" aria-label={t("criticalHint")} />
      )}
    </span>
  );

  let control: ReactNode;
  if (def.type === "bool") {
    control = <Switch checked={value !== "0"} onCheckedChange={(c) => onChange(c ? "1" : "0")} />;
  } else if (def.type === "mask" && def.bits) {
    const maskNum = Number(value);
    const flags = decodeMask(Number.isNaN(maskNum) ? 0 : maskNum, def.bits);
    control = (
      <div className="flex items-center gap-3">
        {def.bits.map((b, i) => (
          <label key={b.bit} className="flex items-center gap-1 text-[12px] text-foreground/80">
            <input
              type="checkbox"
              checked={flags[i]}
              onChange={(e) => {
                const next = [...flags];
                next[i] = e.target.checked;
                onChange(String(encodeMask(next, def.bits!)));
              }}
              className="size-3.5 accent-primary"
            />
            {t(`maskBit.${b.labelKey}`)}
          </label>
        ))}
      </div>
    );
  } else {
    const invalid = !validate(def, value).ok;
    const num = Number(value);
    control = (
      <NumberInput
        value={Number.isNaN(num) ? 0 : num}
        onChange={(v) => onChange(String(v))}
        step={def.step ?? "1"}
        suffix={def.unit ? t(`unit.${def.unit}`) : undefined}
        dirty={dirty || invalid}
      />
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 py-2">
      {left}
      <div className="flex shrink-0 items-center">{control}</div>
    </div>
  );
}
