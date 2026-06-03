import { TextInput, type TextInputProps } from "@/components/ui/TextInput";

/** A small caption above a {@link TextInput} — the label+field pair used across
 *  the form dialogs. All input props pass straight through; `className` lands on
 *  the input (e.g. `mb-3` to space stacked fields). */
export function LabeledTextInput({ label, className, ...props }: TextInputProps & { label: string }) {
  return (
    <>
      <label className="mb-1 block text-[11px] text-muted-foreground">{label}</label>
      <TextInput className={className ?? "w-full"} {...props} />
    </>
  );
}
