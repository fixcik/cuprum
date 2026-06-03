import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Dashed "add / create" tile — the shared pattern used by the Home grid
 *  ("New project") and the project Designs gallery ("Add design"). Stretches to
 *  fill its grid cell; `className` carries a `min-h-*` so it stays sensible when
 *  it's the only tile in the row. */
export function DashedAddTile({
  icon,
  title,
  subtitle,
  onClick,
  className,
}: {
  icon: ReactNode;
  title: string;
  subtitle?: string;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "anim-in flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground",
        className,
      )}
    >
      {icon}
      <span className="text-[13px] font-medium">{title}</span>
      {subtitle && <span className="text-[11px] text-muted-foreground/70">{subtitle}</span>}
    </button>
  );
}
