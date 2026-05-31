import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** A Bambu-style settings section: icon + bold title + a thin rule filling the
 *  rest of the header row, with its rows indented underneath. */
export function SettingsSection({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-4">
      <div className="mb-1 flex items-center gap-2">
        <Icon className="size-4 shrink-0 text-foreground" />
        <span className="text-[13px] font-semibold text-foreground">{title}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <div className="pl-[22px]">{children}</div>
    </div>
  );
}
