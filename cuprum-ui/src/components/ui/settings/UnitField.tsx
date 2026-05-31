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
  return (
    <div className={`relative ${className}`}>
      <TextInput
        type="number"
        step={step}
        inputMode="decimal"
        value={String(value)}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
        className="w-full pr-8 tabular-nums"
      />
      <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
        {unit}
      </span>
    </div>
  );
}
