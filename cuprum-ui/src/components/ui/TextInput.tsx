import * as React from "react";
import { cn } from "@/lib/utils";

export interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** Optional leading icon (e.g. a search glyph). */
  icon?: React.ReactNode;
}

/** Text/search input styled to the design system. */
export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(
  ({ className, icon, ...props }, ref) => {
    const base =
      "h-8 w-full rounded-md border border-input bg-background text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
    if (!icon) {
      return <input ref={ref} className={cn(base, "px-2", className)} {...props} />;
    }
    return (
      <div className="relative w-full">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
          {icon}
        </span>
        <input ref={ref} className={cn(base, "pl-8 pr-2", className)} {...props} />
      </div>
    );
  },
);
TextInput.displayName = "TextInput";
