import { useState } from "react";
import { TextInput } from "@/components/ui/TextInput";
import { useUnitFormat, type Dim } from "@/i18n/useUnitFormat";

/** Number input with a unit suffix rendered inside the field at the right edge
 *  (Bambu-style). Parses the input to a number and reports it via onChange.
 *
 *  The model is always millimetres. Pass `dim` to convert at the UI boundary so
 *  the field shows/accepts the active unit (mm or inch/mil) per Settings —
 *  `value`/`onChange` stay in mm regardless. Without `dim` it shows raw mm with
 *  the literal `unit` suffix (the pre-unit-aware behaviour). */
export function UnitField({
  value,
  onChange,
  unit,
  step = "1",
  className = "w-28",
  invalid = false,
  dim,
}: {
  value: number;
  onChange: (n: number) => void;
  /** Literal suffix when `dim` is omitted; ignored when `dim` is set (the
   *  active unit label is used instead). */
  unit?: string;
  step?: string;
  className?: string;
  /** Mark the field out-of-range: a destructive border instead of silently
   *  coercing the value. The caller keeps the raw value and gates persistence. */
  invalid?: boolean;
  /** Dimension class for unit conversion: "coarse" (mm/inch) or "fine" (mm/mil).
   *  Omit to keep raw mm with the literal `unit` suffix. */
  dim?: Dim;
}) {
  const { units, toDisplay, fromDisplay, unitLabel } = useUnitFormat();
  // Value as shown in the active unit; round so float conversion (200 / 25.4)
  // doesn't surface a long tail. Coarse (inch) keeps 3 decimals, fine (mil) 1.
  const shown = dim ? +toDisplay(value, dim).toFixed(dim === "coarse" ? 3 : 1) : value;
  // mm-tuned steps are wrong in imperial; pick a sensible per-unit step there.
  const effStep = !dim || units !== "imperial" ? step : dim === "coarse" ? "0.001" : "0.1";
  const suffix = dim ? unitLabel(dim) : unit;

  // Keep the raw text while editing so an empty field or an intermediate value
  // like "0." isn't immediately coerced to 0; commit a number only when the text
  // parses to a finite value, and resync to the canonical value on blur.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className={`relative ${className}`}>
      <TextInput
        type="number"
        step={effStep}
        inputMode="decimal"
        value={draft ?? String(shown)}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const n = parseFloat(raw);
          if (raw.trim() !== "" && Number.isFinite(n)) onChange(dim ? fromDisplay(n, dim) : n);
        }}
        onBlur={() => setDraft(null)}
        className={`w-full pr-8 tabular-nums${
          invalid ? " border-destructive focus-visible:ring-destructive" : ""
        }`}
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
        {suffix}
      </span>
    </div>
  );
}
