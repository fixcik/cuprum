import * as React from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Switch } from "@/components/ui/Switch";
import { HelpTip } from "@/components/ui/HelpTip";
import { cn } from "@/lib/utils";
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

/** The bare numeric control: a bordered field with a right-aligned number, a mini
 *  up/down stepper, an optional unit suffix, and a `dirty` accent (orange border +
 *  dot) when changed from factory. No label/row wrapper — embed it in a Row or use
 *  the labelled `NumberField`. Stored value is always millimetres; display/input
 *  go through useUnitFormat. */
export function NumberInput({
  value,
  onChange,
  step = "0.01",
  dim,
  suffix,
  dirty,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: string;
  dim?: Dim;
  suffix?: string;
  /** When true, mark the field changed-from-factory (accent border + dot). */
  dirty?: boolean;
}) {
  const { units, toDisplay, fromDisplay, unitLabel } = useUnitFormat();
  const shown = dim ? toDisplay(value, dim) : value;
  const [text, setText] = React.useState(String(shown));
  // Resync the input when the model value or the units setting changes. Depend on
  // the stable `units` rather than the per-render `toDisplay` identity, so an
  // unrelated re-render can't stomp an in-progress edit.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  React.useEffect(() => setText(String(dim ? toDisplay(value, dim) : value)), [value, dim, units]);
  // In imperial, mm-tuned steps are too coarse/fine; pick a sensible per-unit step.
  const effStep = !dim || units !== "imperial" ? step : dim === "coarse" ? "0.001" : "0.1";
  const suffixText = dim ? unitLabel(dim) : (suffix ?? "");
  const stepNum = parseFloat(effStep) || 1;

  // Commit a value expressed in the CURRENT display unit, converting back to mm.
  const commitDisplay = (display: number) => {
    if (Number.isNaN(display)) return;
    onChange(dim ? fromDisplay(display, dim) : display);
  };
  // Stepper: bump the displayed number by ±step and commit. Rounded to avoid
  // float drift (e.g. 0.1 + 0.01).
  const bump = (dir: 1 | -1) => {
    const cur = parseFloat(text);
    const base = Number.isNaN(cur) ? (dim ? toDisplay(value, dim) : value) : cur;
    const next = Math.round((base + dir * stepNum) * 1e6) / 1e6;
    setText(String(next));
    commitDisplay(next);
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <div
        className={cn(
          "relative flex h-9 w-24 items-center rounded-md border bg-[hsl(var(--input)/0.25)] pl-3 pr-1 transition-colors",
          dirty
            ? "border-primary/70"
            : "border-input hover:border-muted-foreground/40 focus-within:border-muted-foreground/60",
        )}
      >
        {dirty && (
          <span className="absolute -left-1.5 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_6px_hsl(var(--primary)/0.6)]" />
        )}
        <input
          type="number"
          step={effStep}
          inputMode="decimal"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const v = parseFloat(e.target.value);
            if (!Number.isNaN(v)) commitDisplay(v);
          }}
          className="w-full bg-transparent text-right text-[13px] tabular-nums text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <div className="ml-1 flex shrink-0 flex-col text-muted-foreground">
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={(e) => {
              e.preventDefault();
              bump(1);
            }}
            className="grid h-[14px] w-4 place-items-center rounded-sm hover:bg-foreground/10 hover:text-foreground"
          >
            <ChevronUp className="size-3" />
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={(e) => {
              e.preventDefault();
              bump(-1);
            }}
            className="grid h-[14px] w-4 place-items-center rounded-sm hover:bg-foreground/10 hover:text-foreground"
          >
            <ChevronDown className="size-3" />
          </button>
        </div>
      </div>
      {suffixText && (
        <span className="w-7 text-[11px] leading-[1.05] text-muted-foreground">{suffixText}</span>
      )}
    </div>
  );
}

/** A labelled numeric field: a label cell (+ hint/help) on the left and a
 *  `NumberInput` control on the right. Used in the flat `divide-y` settings lists
 *  (SettingsPage / ToolLibrary). */
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
  dirty,
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
  /** When true, mark the field changed-from-factory (accent border + dot). */
  dirty?: boolean;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-2">
      <FieldLabel label={label} hint={hint} help={help} helpImage={helpImage} />
      <NumberInput value={value} onChange={onChange} step={step} dim={dim} suffix={suffix} dirty={dirty} />
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
