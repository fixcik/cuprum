import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

interface InlineEditableFieldProps {
  value: string;
  onCommit: (value: string) => void;
  placeholder: string;
  multiline?: boolean;
  displayClassName?: string;
  inputClassName?: string;
  ariaLabel: string;
}

export function InlineEditableField({
  value,
  onCommit,
  placeholder,
  multiline = false,
  displayClassName,
  inputClassName,
  ariaLabel,
}: InlineEditableFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);

  useEffect(() => {
    if (!editing) return;
    if (multiline) {
      textareaRef.current?.focus();
      textareaRef.current?.select();
      return;
    }
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing, multiline]);

  const commit = () => {
    setEditing(false);
    if (draft !== value) onCommit(draft);
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  const fieldClass = cn(
    "w-full rounded-md border border-input bg-background px-2 py-1 text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring",
    inputClassName,
  );

  if (editing) {
    if (multiline) {
      return (
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          rows={3}
          className={cn(fieldClass, "resize-none")}
          aria-label={ariaLabel}
        />
      );
    }

    return (
      <input
        ref={inputRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          }
        }}
        className={fieldClass}
        aria-label={ariaLabel}
      />
    );
  }

  const isPlaceholder = !value.trim();

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      className={cn(
        "w-full rounded-md px-1 py-0.5 text-left transition hover:bg-muted/40",
        isPlaceholder && "text-muted-foreground",
        displayClassName,
      )}
    >
      {isPlaceholder ? placeholder : value}
    </button>
  );
}
