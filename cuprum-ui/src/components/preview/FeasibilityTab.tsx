import { MapPin } from "lucide-react";
import { useTranslation } from "react-i18next";
import { type Finding } from "@/lib/feasibility";
import { SEVERITY } from "@/lib/severity";
import { PanelStatus } from "@/components/ui/PanelStatus";
import { useFindingText } from "@/hooks/useFindingText";

function FindingRow({
  f,
  active,
  onFocus,
}: {
  f: Finding;
  /** Active hotspot index for this finding (it's the focused one), or null. */
  active: number | null;
  onFocus?: (fid: string, hi: number) => void;
}) {
  const { tr, measuredLimit } = useFindingText();
  const { Icon, fg: color } = SEVERITY[f.severity];
  const ml = measuredLimit(f);
  const n = f.hotspots?.length ?? 0;
  const k = active ?? 0;
  const clickable = n > 0 && !!onFocus;
  return (
    <div
      onClick={clickable ? () => onFocus!(f.id, k) : undefined}
      className={`flex items-start gap-2.5 border-b border-border px-3 py-2.5 ${
        clickable ? "cursor-pointer hover:bg-foreground/5" : ""
      } ${active != null ? "bg-foreground/5" : ""}`}
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="flex items-center gap-1.5 text-[12px] text-foreground">
            {tr(f.label)}
            {n > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                <MapPin className="size-3" />
                {n > 1 && !f.highlightAll && <span className="tabular-nums">{n}</span>}
              </span>
            )}
          </span>
          <span className="shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">{ml.measured}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-3">
          <span className="text-[10px] text-muted-foreground">{ml.limit}</span>
        </div>
        {f.detail && <p className={`mt-1 text-[10px] leading-relaxed ${color}`}>{tr(f.detail)}</p>}
      </div>
    </div>
  );
}

/** Feasibility tab: each measured fact judged against the capability profile,
 *  with an overall verdict header. Findings with located hotspots are clickable
 *  (focus the 2D preview) and carry a ◂ k/N ▸ stepper. */
export function FeasibilityTab({
  findings,
  loading,
  focus,
  onFocus,
}: {
  findings: Finding[];
  loading?: boolean;
  focus?: { fid: string; hi: number } | null;
  onFocus?: (fid: string, hi: number) => void;
}) {
  const { t } = useTranslation("feasibility");
  if (loading && findings.length === 0) {
    return <PanelStatus loading message={t("chrome.loading")} />;
  }
  if (findings.length === 0) {
    return <PanelStatus message={t("chrome.noData")} />;
  }

  const blocks = findings.filter((f) => f.severity === "block").length;
  const warns = findings.filter((f) => f.severity === "warn").length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="text-[11px] text-muted-foreground">
          {blocks > 0 && t("chrome.blocks", { count: blocks })}
          {blocks > 0 && warns > 0 && " · "}
          {warns > 0 && t("chrome.warns", { count: warns })}
          {blocks === 0 && warns === 0 && t("chrome.allOk")}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {findings.map((f) => (
          <FindingRow key={f.id} f={f} active={focus?.fid === f.id ? focus.hi : null} onFocus={onFocus} />
        ))}
      </div>
      <p className="border-t border-border px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
        {t("chrome.footer")}
      </p>
    </div>
  );
}
