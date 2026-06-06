import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** A titled card container for the CNC control screen: rounded-xl border on the
 *  card surface, an optional header (icon + uppercase title + right slot), and a
 *  padded body. Pass `bodyClassName` to override the default padding. */
export function Card({
  title,
  icon: Icon,
  right,
  className,
  bodyClassName = "p-4",
  children,
}: {
  title?: ReactNode;
  icon?: LucideIcon;
  right?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn("rounded-xl border border-border bg-card", className)}>
      {title != null && (
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          {Icon && <Icon className="size-4 text-muted-foreground" />}
          <span className="text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
            {title}
          </span>
          {right && <div className="ml-auto flex items-center gap-1.5">{right}</div>}
        </header>
      )}
      <div className={bodyClassName}>{children}</div>
    </section>
  );
}
