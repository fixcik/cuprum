import type { ReactNode } from "react";

/** One compact settings row: muted label on the left, control on the right.
 *  No dividers — sections group rows visually. */
export function SettingRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-1.5">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}
