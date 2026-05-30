import { CheckCircle2, AlertTriangle, XCircle, Info, Loader2, MapPin } from "lucide-react";
import { type Finding, type Severity } from "@/lib/feasibility";

const ICON: Record<Severity, { Icon: typeof CheckCircle2; color: string }> = {
  ok: { Icon: CheckCircle2, color: "text-success" },
  warn: { Icon: AlertTriangle, color: "text-warning" },
  block: { Icon: XCircle, color: "text-destructive" },
  info: { Icon: Info, color: "text-muted-foreground" },
};

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
  const { Icon, color } = ICON[f.severity];
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
            {f.label}
            {n > 0 && (
              <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                <MapPin className="size-3" />
                {n > 1 && !f.highlightAll && <span className="tabular-nums">{n}</span>}
              </span>
            )}
          </span>
          <span className="shrink-0 text-right text-[12px] tabular-nums text-muted-foreground">{f.measured}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-3">
          <span className="text-[10px] text-muted-foreground">{f.limit}</span>
        </div>
        {f.detail && <p className={`mt-1 text-[10px] leading-relaxed ${color}`}>{f.detail}</p>}
      </div>
    </div>
  );
}

/** "Проверка" tab: each measured fact judged against the capability profile,
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
  if (loading && findings.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="size-5 animate-spin text-primary" /> Проверяем выполнимость…
      </div>
    );
  }
  if (findings.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
        Нет данных — назначьте слои.
      </div>
    );
  }

  const blocks = findings.filter((f) => f.severity === "block").length;
  const warns = findings.filter((f) => f.severity === "warn").length;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <span className="text-[11px] text-muted-foreground">
          {blocks > 0 && `${blocks} блок.`}
          {blocks > 0 && warns > 0 && " · "}
          {warns > 0 && `${warns} риск.`}
          {blocks === 0 && warns === 0 && "всё в норме"}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {findings.map((f) => (
          <FindingRow key={f.id} f={f} active={focus?.fid === f.id ? focus.hi : null} onFocus={onFocus} />
        ))}
      </div>
      <p className="border-t border-border px-3 py-2 text-[10px] leading-relaxed text-muted-foreground">
        Пороги задаются в настройках. Строки без проблем не показываются.
      </p>
    </div>
  );
}
