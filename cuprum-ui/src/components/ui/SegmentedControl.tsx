import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface SegmentOption<T extends string> {
  value: T;
  label?: string;
  icon?: ReactNode;
  title?: string;
  /** Accent colour applied regardless of active state, so a tab draws attention
   *  (e.g. a failing DFM verdict) and isn't missed among the muted ones. */
  tone?: "danger" | "warning" | "success";
}

const TONE_CLS: Record<NonNullable<SegmentOption<string>["tone"]>, { active: string; idle: string }> = {
  danger: { active: "bg-destructive/20 text-destructive", idle: "text-destructive hover:bg-destructive/10" },
  warning: { active: "bg-warning/20 text-warning", idle: "text-warning hover:bg-warning/10" },
  success: { active: "bg-success/20 text-success", idle: "text-success hover:bg-success/10" },
};

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
}: {
  options: SegmentOption<T>[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex overflow-hidden rounded-md border border-border bg-card/80 shadow-sm backdrop-blur",
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            title={opt.title ?? opt.label}
            onClick={() => onChange(opt.value)}
            className={cn(
              "flex cursor-pointer items-center gap-1 whitespace-nowrap px-2 py-1 text-[12px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              opt.tone
                ? active
                  ? TONE_CLS[opt.tone].active
                  : TONE_CLS[opt.tone].idle
                : active
                  ? "bg-primary/20 text-primary"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
            )}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
