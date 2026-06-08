import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** A section card with an icon + uppercase title header and a padded body.
 *  Matches the equipment "Карточки" design: rounded-xl, subtle card background,
 *  a bottom-bordered header row, optional right-aligned slot (e.g. a badge). */
export function Card({
  icon: Icon,
  title,
  accent,
  headerRight,
  children,
  className,
}: {
  icon: LucideIcon;
  title: string;
  /** Tint the header icon with the accent colour instead of the muted one. */
  accent?: boolean;
  headerRight?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-border bg-card/70", className)}>
      <header className="flex items-center gap-2 border-b border-border/70 px-3.5 py-2.5">
        <Icon className={cn("size-4", accent ? "text-primary" : "text-muted-foreground")} />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/85">
          {title}
        </span>
        {headerRight && <div className="ml-auto">{headerRight}</div>}
      </header>
      <div className="p-3.5">{children}</div>
    </section>
  );
}
