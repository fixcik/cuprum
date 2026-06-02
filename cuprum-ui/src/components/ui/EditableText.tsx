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
  // Latest prop, read inside commit/cancel — those capture the render's closure,
  // so an external rename/undo while editing would otherwise compare to a stale
  // `value`.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);
  // Enter / Escape call setEditing(false), which unmounts the input and fires a
  // synthetic blur on the way out — that blur would run commit() a SECOND time
  // (double onCommit → double undo + persist), or turn an Escape into a commit.
  // This latch makes the first commit/cancel of an edit session the only one.
  const doneRef = useRef(false);

  // Keep the draft in sync with external changes (rename elsewhere, undo/redo)
  // while not actively editing.
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      doneRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
    const next = draft.trim();
    if (next && next !== valueRef.current) onCommit(next);
    else setDraft(valueRef.current); // empty or unchanged → revert
  };

  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    setEditing(false);
    setDraft(valueRef.current);
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
          else if (e.key === "Escape") cancel();
        }}
        className={cn(
          "min-w-0 rounded border border-input bg-background px-1 outline-none focus-visible:ring-1 focus-visible:ring-ring",
          className,
        )}
      />
    );
  }

  return (
    // No aria-label here: the visible {value} (the design name) IS the button's
    // accessible name. ariaLabel describes the action and lives only in `title`
    // (tooltip) + on the input, which has no visible label. (WCAG 2.5.3)
    <button
      type="button"
      title={title}
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
