import { useTranslation } from "react-i18next";
import type { BoardMetrics } from "@/lib/api";
import { minAbove } from "@/lib/feasibility";
import { PanelStatus } from "@/components/ui/PanelStatus";
import { useSettings } from "@/settingsStore";
import { useUnitFormat } from "@/i18n/useUnitFormat";

/** One label/value row. */
function Row({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-3 py-1.5">
      <span className="text-[12px] text-muted-foreground">{label}</span>
      <span className={`text-right text-[12px] tabular-nums ${muted ? "text-muted-foreground" : "text-foreground"}`}>
        {value}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="border-b border-border bg-panel/60 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

/** Metrics tab: the measured manufacturing facts, no judgement. */
export function MetricsTab({ metrics, loading }: { metrics: BoardMetrics | null; loading?: boolean }) {
  const { t } = useTranslation(["metrics", "common"]);
  const { fmtLen } = useUnitFormat();
  const ignoreBelow = useSettings((s) => s.profile.ignoreBelowMm);

  /** Format a nullable length, falling back to em dash. */
  const fmtMm = (v: number | null) => (v != null ? fmtLen(v) : t("common:dash"));

  if (loading && !metrics) {
    return <PanelStatus loading message={t("metrics:loading")} />;
  }
  if (!metrics) {
    return <PanelStatus message={t("metrics:noData")} />;
  }

  const { board, layers, copper, drill, geo } = metrics;

  // Build the copper-sides label list (e.g. "top, bottom, inner ×2").
  const copperSides = [
    layers.copperTop && t("metrics:side.top"),
    layers.copperBottom && t("metrics:side.bottom"),
    layers.innerCopperCount > 0 && `${t("metrics:side.inner")} ×${layers.innerCopperCount}`,
  ].filter(Boolean) as string[];

  /** Map a side key string ("top" | "bottom" | anything else) to a localized label. */
  const sideLabel = (s: string) =>
    s === "top"
      ? t("metrics:side.top")
      : s === "bottom"
        ? t("metrics:side.bottom")
        : t("metrics:side.inner");

  return (
    <div className="h-full overflow-auto">
      <SectionTitle>{t("metrics:section.dimensions")}</SectionTitle>
      <Row
        label={t("metrics:row.size")}
        value={board.hasEdgeLayer ? `${fmtLen(board.widthMm)} × ${fmtLen(board.heightMm)}` : t("common:dash")}
      />
      <Row
        label={t("metrics:row.outlineClosed")}
        value={board.hasEdgeLayer ? (board.outlineClosed ? t("common:yes") : t("common:no")) : t("metrics:noOutline")}
      />
      <Row label={t("metrics:row.cutouts")} value={`${board.cutoutCount}`} />

      <SectionTitle>{t("metrics:section.layers")}</SectionTitle>
      <Row
        label={t("metrics:row.copper")}
        value={`${layers.copperLayerCount}${copperSides.length ? ` (${copperSides.join(", ")})` : ""}`}
      />
      <Row
        label={t("metrics:row.mask")}
        value={
          [layers.hasMaskTop && t("metrics:side.top"), layers.hasMaskBottom && t("metrics:side.bottom")]
            .filter(Boolean)
            .join(", ") || t("common:no")
        }
      />
      <Row
        label={t("metrics:row.silk")}
        value={
          [layers.hasSilkTop && t("metrics:side.top"), layers.hasSilkBottom && t("metrics:side.bottom")]
            .filter(Boolean)
            .join(", ") || t("common:no")
        }
      />
      <Row label={t("metrics:row.paste")} value={layers.hasPaste ? t("common:yes") : t("common:no")} />

      {copper.length > 0 && (
        <>
          <SectionTitle>{t("metrics:section.minTrace")}</SectionTitle>
          {copper.map((c, i) => {
            const minW = minAbove(c.traceWidthsMm, ignoreBelow);
            return (
              <Row
                key={i}
                label={sideLabel(c.side)}
                value={minW != null ? fmtLen(minW) : t("metrics:noTraces")}
                muted={minW == null}
              />
            );
          })}
        </>
      )}

      <SectionTitle>{t("metrics:section.copperGeo")}</SectionTitle>
      <Row label={t("metrics:row.minClearance")} value={fmtMm(geo.minClearanceMm)} muted={geo.minClearanceMm == null} />
      <Row label={t("metrics:row.minCopperWidth")} value={fmtMm(geo.minCopperWidthMm)} muted={geo.minCopperWidthMm == null} />
      <Row
        label={t("metrics:row.copperCoverage")}
        value={geo.copperCoveragePct != null ? `${+geo.copperCoveragePct.toFixed(2)} %` : t("common:dash")}
        muted={geo.copperCoveragePct == null}
      />
      <Row label={t("metrics:row.traceCount")} value={`${geo.traceCount}`} muted={geo.traceCount === 0} />
      <Row
        label={t("metrics:row.traceLength")}
        value={geo.traceCount > 0 ? fmtLen(geo.traceTotalLengthMm) : t("common:dash")}
        muted={geo.traceCount === 0}
      />

      <SectionTitle>{t("metrics:section.drill")}</SectionTitle>
      <Row label={t("metrics:row.totalHoles")} value={`${drill.totalHoles}`} />
      <Row label={t("metrics:row.minDiameter")} value={fmtMm(drill.minHoleMm)} />
      <Row
        label={t("metrics:row.toolDiameters")}
        value={drill.uniqueToolDiametersMm.length ? drill.uniqueToolDiametersMm.map(fmtLen).join(", ") : t("common:dash")}
      />
      <Row label={t("metrics:row.platedNonplated")} value={`${drill.platedHoleCount} / ${drill.nonplatedHoleCount}`} />
      <Row label={t("metrics:row.minAnnular")} value={fmtMm(geo.minAnnularMm)} muted={geo.minAnnularMm == null} />
      <Row
        label={t("metrics:row.slots")}
        value={
          geo.slotCount > 0
            ? geo.minSlotWidthMm != null
              ? t("metrics:slotsWithMin", { count: geo.slotCount, min: fmtLen(geo.minSlotWidthMm) })
              : `${geo.slotCount}`
            : t("metrics:noSlots")
        }
        muted={geo.slotCount === 0}
      />

      {(layers.hasMaskTop || layers.hasMaskBottom || layers.hasSilkTop || layers.hasSilkBottom) && (
        <>
          <SectionTitle>{t("metrics:section.maskSilk")}</SectionTitle>
          <Row label={t("metrics:row.maskDam")} value={fmtMm(geo.minMaskDamMm)} muted={geo.minMaskDamMm == null} />
          {(() => {
            const s = minAbove(geo.silkLineWidthsMm, ignoreBelow);
            return (
              <Row
                label={t("metrics:row.minSilkLine")}
                value={s != null ? fmtLen(s) : t("common:dash")}
                muted={s == null}
              />
            );
          })()}
        </>
      )}

      <SectionTitle>{t("metrics:section.registration")}</SectionTitle>
      <Row label={t("metrics:row.layerOvershoot")} value={fmtMm(geo.layerOvershootMm)} muted={geo.layerOvershootMm == null} />
    </div>
  );
}
