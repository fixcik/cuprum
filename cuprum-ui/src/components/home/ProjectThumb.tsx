import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

/** Collapsed DFM verdict for a project. A property of the *panel* (not the
 *  designs inside) — computed elsewhere later; for now callers pass "ok". */
export type ThumbVerdict = "ok" | "warn" | "block" | "none";

const DOT: Record<ThumbVerdict, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  block: "bg-destructive",
  none: "bg-muted-foreground/40",
};

/** First letter of the project name, uppercased; "?" when empty. */
function initial(name: string): string {
  return (name.trim()[0] || "?").toUpperCase();
}

/** Monogram preview placeholder on a "PCB blank" grid, with a DFM verdict dot in
 *  the corner. A temporary stand-in until a real composited board preview (as in
 *  DesignCard / LayerStack) is wired in. `variant` scales the monogram for the
 *  large grid card vs the small list-row thumbnail. */
export function ProjectThumb({
  name,
  verdict = "ok",
  variant = "grid",
  className,
}: {
  name: string;
  verdict?: ThumbVerdict;
  variant?: "grid" | "list";
  className?: string;
}) {
  const { t } = useTranslation("home");
  // Screen-reader label for the verdict dot — only meaningful when an actual
  // verdict is known (not "none"). The dot is decorative when verdict = "none".
  const dotLabel =
    verdict !== "none" ? t(`verdictDot.${verdict}`) : undefined;
  return (
    <div className={cn("pcb-grid relative w-full overflow-hidden", className)}>
      <div className="absolute inset-0 flex items-center justify-center">
        <div className="grid size-1/2 max-h-[64%] max-w-[64%] place-items-center rounded-md border border-primary/30 bg-primary/[0.06]">
          <span
            className={cn(
              "font-semibold text-primary/55",
              variant === "grid" ? "text-[28px]" : "text-[15px]",
            )}
          >
            {initial(name)}
          </span>
        </div>
      </div>
      <span
        className={cn(
          "absolute right-2 top-2 size-2.5 rounded-full ring-2 ring-pcb-preview",
          DOT[verdict],
        )}
        aria-label={dotLabel}
        aria-hidden={dotLabel === undefined ? true : undefined}
        role={dotLabel !== undefined ? "img" : undefined}
      />
    </div>
  );
}
