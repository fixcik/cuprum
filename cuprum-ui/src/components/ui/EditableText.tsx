import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Inline-editable text. Renders as a label button; clicking it turns it into an
 *  input. Enter or blur commits a trimmed value via `onCommit`; Escape — or an
 *  empty / unchanged value — cancels back to `value`. Lets a name be renamed in
 *  place without a separate dialog. `className` is applied to BOTH the label and
 *  the input so typography stays identical and the layout doesn't jump on edit. */
export function EditableText({
  value,
  onCommit,
  className,
  title,
  ariaLabel,
}: {
  value: string;
  onCommit: (next: string) => void;
  className?: string;
  title?: string;
  ariaLabel?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the draft in sync with external changes (rename elsewhere, undo/redo)
  // while not actively editing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value); // empty or unchanged → revert
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={draft}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") {
            setDraft(value);
            setEditing(false);
          }
        }}
        className={cn(
          "min-w-0 rounded border border-input bg-background px-1 outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
      />
    );
  }

  return (
    <button
      type="button"
      title={title}
      aria-label={ariaLabel}
      onClick={() => setEditing(true)}
      className={cn(
        "cursor-text truncate rounded px-1 text-left hover:bg-foreground/5",
        className,
      )}
    >
      {value}
    </button>
  );
}
