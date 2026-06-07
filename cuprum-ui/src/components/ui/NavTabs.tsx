import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One tab in a {@link NavTabs} bar. `icon` is a node (not a component) so the
 *  caller controls it per-state — e.g. swap in a spinner while loading. `trailing`
 *  sits after the label (e.g. a status dot); `tone` tints both active and idle so a
 *  tab can draw attention (e.g. a failing verdict) and isn't lost among the rest. */
export interface NavTab<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  trailing?: ReactNode;
  tone?: "danger" | "warning";
  title?: string;
}

const ACTIVE: Record<"default" | "danger" | "warning", string> = {
  default: "bg-primary/15 text-primary",
  danger: "bg-destructive/15 text-destructive",
  warning: "bg-warning/15 text-warning",
};
const IDLE: Record<"default" | "danger" | "warning", string> = {
  default: "text-muted-foreground hover:text-foreground",
  danger: "text-destructive/80 hover:text-destructive",
  warning: "text-warning/80 hover:text-warning",
};

/** Bambu-style tab bar: separate rounded buttons, active one tinted. Renders the
 *  buttons as a fragment so it slots straight into a flex row alongside other
 *  controls (e.g. a gear or progress ring). Shared by the project header and the
 *  design inspector. */
export function NavTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: NavTab<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <>
      {tabs.map((tab) => {
        const active = tab.id === value;
        const tone = tab.tone ?? "default";
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            title={tab.title ?? tab.label}
            className={cn(
              "flex items-center gap-2 rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
              active ? ACTIVE[tone] : IDLE[tone],
            )}
          >
            {tab.icon}
            {tab.label}
            {tab.trailing}
          </button>
        );
      })}
    </>
  );
}
