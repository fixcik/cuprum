import * as React from "react";
import { TextInput } from "@/components/ui/TextInput";
import { Switch } from "@/components/ui/Switch";
import { HelpTip } from "@/components/ui/HelpTip";
import { useUnitFormat, type Dim } from "@/i18n/useUnitFormat";

/** Label cell: text + optional inline hint + an optional "?" help tooltip. */
export function FieldLabel({
  label,
  hint,
  help,
  helpImage,
}: {
  label: string;
  hint?: string;
  help?: string;
  helpImage?: React.ReactNode;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-foreground">
      {label}
      {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
      {help && <HelpTip text={help} image={helpImage} />}
    </span>
  );
}

/** A labelled numeric field that commits any valid number live. Supports unit conversion via dim. */
export function NumberField({
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

export function BoolField({
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
