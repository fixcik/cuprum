import type { ReactNode } from "react";
import { HelpTip } from "@/components/ui/HelpTip";
import { cn } from "@/lib/utils";

/** A labelled settings row: wrapping label (+ optional inline hint / "?" help)
 *  on the left, a control slot on the right. Label wraps via text-balance rather
 *  than truncating, so long Russian labels stay readable. */
export function Row({
  label,
  hint,
  help,
  dense,
  children,
}: {
  label: string;
  /** Small inline secondary text after the label. */
  hint?: string;
  /** "?" tooltip text. */
  help?: string;
  dense?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3", dense ? "py-1.5" : "py-2")}>
      <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-tight text-foreground/90">
        <span className="text-balance">{label}</span>
        {hint && <span className="text-[10px] text-muted-foreground">{hint}</span>}
        {help && <HelpTip text={help} />}
      </span>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  );
}
