import { useTranslation } from "react-i18next";
import { OctagonX } from "lucide-react";
import { cn } from "@/lib/utils";

/** Big red emergency-stop button. `compact` shrinks it for tight toolbars.
 *  Wiring (what it sends) is the caller's concern — this is presentation only. */
export function EStop({ compact = false, onClick }: { compact?: boolean; onClick?: () => void }) {
  const { t } = useTranslation("machine");
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "estop-glow group relative inline-flex items-center justify-center gap-2 rounded-full",
        "bg-destructive font-bold uppercase tracking-wide text-white transition-all active:scale-95",
        compact ? "h-9 px-3 text-[12px]" : "h-11 px-5 text-[13px]",
      )}
    >
      <span
        className="grid place-items-center rounded-full bg-white/20"
        style={{ width: compact ? 18 : 22, height: compact ? 18 : 22 }}
      >
        <OctagonX className={compact ? "size-3.5" : "size-4"} />
      </span>
      {t("estop")}
    </button>
  );
}
