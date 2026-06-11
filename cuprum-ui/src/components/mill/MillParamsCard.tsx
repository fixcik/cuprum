import { useTranslation } from "react-i18next";
import { UnitField } from "@/components/ui/settings/UnitField";
import type { MillCutParams } from "@/hooks/useMillPlan";

export interface MillParamsCardProps {
  params: MillCutParams;
  onChange: (patch: Partial<MillCutParams>) => void;
}

/** One labelled row: label on the left, control on the right. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

/** Cut-parameter controls for the isolation-milling run (right inspector). All
 *  lengths are millimetres in the model; UnitField converts for display/input per
 *  the units setting. The heavy planning is in Rust — this only edits the input. */
export function MillParamsCard({ params, onChange }: MillParamsCardProps) {
  const { t } = useTranslation("mill");

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/40 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {t("params.title")}
      </div>

      {/* Cut width (effective bit width) */}
      <Row label={t("params.cutWidth")}>
        <UnitField
          value={params.cutWidthMm}
          onChange={(n) => onChange({ cutWidthMm: n })}
          dim="fine"
          step="0.05"
          className="w-28"
        />
      </Row>

      {/* Passes */}
      <Row label={t("params.passes")}>
        <input
          type="number"
          min={1}
          step={1}
          value={params.passes}
          onChange={(e) => {
            const n = parseInt(e.target.value, 10);
            if (Number.isFinite(n) && n >= 1) onChange({ passes: n });
          }}
          className="h-8 w-28 rounded-md border border-border bg-background px-2 text-right text-sm tabular-nums"
        />
      </Row>

      {/* Overlap (0..1) */}
      <Row label={t("params.overlap")}>
        <div className="relative w-28">
          <input
            type="number"
            min={0}
            max={0.95}
            step={0.05}
            value={params.overlap}
            onChange={(e) => {
              const n = parseFloat(e.target.value);
              if (Number.isFinite(n)) onChange({ overlap: Math.min(Math.max(n, 0), 0.95) });
            }}
            className="h-8 w-full rounded-md border border-border bg-background px-2 pr-8 text-right text-sm tabular-nums"
          />
          <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground">
            ×
          </span>
        </div>
      </Row>

      {/* Climb / conventional toggle */}
      <Row label={t("params.direction")}>
        <button
          type="button"
          onClick={() => onChange({ climb: !params.climb })}
          className="h-8 rounded-md border border-border bg-background px-3 text-[12px] text-foreground transition-colors hover:border-primary/50"
        >
          {params.climb ? t("params.climb") : t("params.conventional")}
        </button>
      </Row>

      <div className="my-1 border-t border-border/60" />

      {/* Cut depth */}
      <Row label={t("params.cutDepth")}>
        <UnitField
          value={params.cutDepthMm}
          onChange={(n) => onChange({ cutDepthMm: n })}
          dim="fine"
          step="0.01"
          className="w-28"
        />
      </Row>

      {/* Depth per pass (optional multi-depth) */}
      <Row label={t("params.depthPerPass")}>
        <UnitField
          value={params.depthPerPassMm ?? 0}
          onChange={(n) => onChange({ depthPerPassMm: n > 0 ? n : null })}
          dim="fine"
          step="0.01"
          className="w-28"
        />
      </Row>

      {/* XY feed (mm/min — not a length dim) */}
      <Row label={t("params.feedXy")}>
        <UnitField
          value={params.feedXyMmMin}
          onChange={(n) => onChange({ feedXyMmMin: n })}
          unit={t("params.mmMin")}
          step="10"
          className="w-28"
        />
      </Row>

      {/* Plunge feed */}
      <Row label={t("params.plunge")}>
        <UnitField
          value={params.plungeMmMin}
          onChange={(n) => onChange({ plungeMmMin: n })}
          unit={t("params.mmMin")}
          step="5"
          className="w-28"
        />
      </Row>
    </div>
  );
}
