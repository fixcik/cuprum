import { Loader2 } from "lucide-react";

/** Centered, full-height status for a preview panel — an optional spinner above
 *  an optional message. Covers the loading / empty (“no data”) states that the
 *  preview tabs previously each re-implemented with identical markup. */
export function PanelStatus({
  loading = false,
  message,
  spinnerClassName = "size-5",
  className = "",
}: {
  /** Show the spinning loader. */
  loading?: boolean;
  /** Caption under the spinner (e.g. “Loading…”, “No data”). Omit for spinner-only. */
  message?: string;
  /** Spinner size class (default `size-5`; the 3D view uses `size-6`). */
  spinnerClassName?: string;
  /** Extra container classes (e.g. `w-full`). */
  className?: string;
}) {
  return (
    <div
      className={`flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-[13px] text-muted-foreground ${className}`}
    >
      {loading && <Loader2 className={`${spinnerClassName} animate-spin text-primary`} />}
      {message && <span>{message}</span>}
    </div>
  );
}
