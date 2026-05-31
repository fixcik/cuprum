import { useState } from "react";
import { TextInput } from "@/components/ui/TextInput";

/** Number input with a unit suffix rendered inside the field at the right edge
 *  (Bambu-style). Parses the input to a number and reports it via onChange. */
export function UnitField({
  value,
  onChange,
  unit,
  step = "1",
  className = "w-28",
}: {
  value: number;
  onChange: (n: number) => void;
  unit: string;
  step?: string;
  className?: string;
}) {
  // Keep the raw text while editing so an empty field or an intermediate value
  // like "0." isn't immediately coerced to 0; commit a number only when the text
  // parses to a finite value, and resync to the canonical value on blur.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className={`relative ${className}`}>
      <TextInput
        type="number"
        step={step}
        inputMode="decimal"
        value={draft ?? String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          setDraft(raw);
          const n = parseFloat(raw);
          if (raw.trim() !== "" && Number.isFinite(n)) onChange(n);
        }}
        onBlur={() => setDraft(null)}
        className="w-full pr-8 tabular-nums"
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
        {unit}
      </span>
    </div>
  );
}
