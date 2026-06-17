import { useTranslation } from "react-i18next";
import { Square } from "lucide-react";
import { api } from "@/lib/api";
import { useDrillRunStore } from "@/drillRunStore";
import { isBannerVisible, phaseLabel, percent } from "@/lib/drillRunBannerView";

/** Live drill-run banner in the Operations left column. Reads the app-root
 *  `drillRunStore` (fed by `drill-run://*` broadcasts). Hidden when no run is live.
 *  "Стоп" → graceful stop; clicking the body focuses the drill window. */
export function DrillRunBanner() {
  const { t } = useTranslation("project");
  const active = useDrillRunStore((s) => s.active);
  const phase = useDrillRunStore((s) => s.phase);
  const holesCompleted = useDrillRunStore((s) => s.holesCompleted);
  const holesTotal = useDrillRunStore((s) => s.holesTotal);
  const diameterMm = useDrillRunStore((s) => s.diameterMm);

  if (!isBannerVisible(active, phase)) return null;

  const { key, pulsing } = phaseLabel(phase);
  const pct = percent(holesCompleted, holesTotal);
  const stopping = phase === "stopping";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => void api.openDrillWindow()}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          void api.openDrillWindow();
        }
      }}
      className="cursor-pointer rounded-xl border border-primary/40 bg-primary/[0.08] p-4 transition-colors hover:border-primary/60"
    >
      {/* Row 1: phase label + step name + Stop */}
      <div className="flex items-center gap-2.5">
        <span
          className={`size-2 shrink-0 rounded-full bg-primary ${pulsing ? "animate-pulse" : ""}`}
          aria-hidden
        />
        <span className="text-[11px] font-bold uppercase tracking-[0.06em] text-primary">
          {t(key)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">
          {t("operations.drill.title")}
        </span>
        {!stopping && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void api.drillRun.stop();
            }}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/15 px-2.5 py-1 text-[12px] font-semibold text-destructive transition-colors hover:bg-destructive/25"
          >
            <Square className="size-3 fill-current" />
            {t("operations.banner.stop")}
          </button>
        )}
      </div>

      {/* Row 2: hole counter + tool · percent */}
      <div className="mt-2.5 flex items-center justify-between gap-2 text-[12px] tabular-nums">
        <span className="min-w-0 truncate text-muted-foreground">
          {holesTotal > 0 && (
            <>
              {t("operations.banner.hole")} {holesCompleted}/{holesTotal}
            </>
          )}
          {diameterMm != null && (
            <>
              {holesTotal > 0 ? " · " : ""}
              {t("operations.banner.tool", { mm: diameterMm })}
            </>
          )}
        </span>
        <span className="shrink-0 font-semibold text-primary">{pct}%</span>
      </div>

      {/* Row 3: progress track */}
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
