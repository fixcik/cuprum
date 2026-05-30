import { Loader2 } from "lucide-react";
import type { BoardMetrics } from "@/lib/api";
import { fmtLen, minAbove } from "@/lib/feasibility";
import { useSettings } from "@/settingsStore";

const num = (v: number) => {
  const a = Math.abs(v);
  return a > 0 && a < 0.1 ? `${+v.toFixed(3)}` : `${+v.toFixed(2)}`;
};
// Microns for sub-0.1 mm values so a tiny feature isn't shown as a flat "0".
const mm = (v: number | null) => (v != null ? fmtLen(v) : "—");
const yn = (b: boolean) => (b ? "да" : "нет");

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
  const ignoreBelow = useSettings((s) => s.profile.ignoreBelowMm);
  if (loading && !metrics) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-[13px] text-muted-foreground">
        <Loader2 className="size-5 animate-spin text-primary" /> Измеряем плату…
      </div>
    );
  }
  if (!metrics) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-[13px] text-muted-foreground">
        Нет данных — назначьте слои.
      </div>
    );
  }

  const { board, layers, copper, drill, geo } = metrics;
  const copperSides = [
    layers.copperTop && "верх",
    layers.copperBottom && "низ",
    layers.innerCopperCount > 0 && `внутр. ×${layers.innerCopperCount}`,
  ].filter(Boolean) as string[];
  const sideLabel = (s: string) => (s === "top" ? "верх" : s === "bottom" ? "низ" : "внутр.");

  return (
    <div className="h-full overflow-auto">
      <SectionTitle>Габариты</SectionTitle>
      <Row label="Размер" value={board.hasEdgeLayer ? `${num(board.widthMm)} × ${num(board.heightMm)} мм` : "—"} />
      <Row label="Контур замкнут" value={board.hasEdgeLayer ? yn(board.outlineClosed) : "нет контура"} />
      <Row label="Внутренние вырезы" value={`${board.cutoutCount}`} />

      <SectionTitle>Слои</SectionTitle>
      <Row label="Медь" value={`${layers.copperLayerCount}${copperSides.length ? ` (${copperSides.join(", ")})` : ""}`} />
      <Row
        label="Маска"
        value={[layers.hasMaskTop && "верх", layers.hasMaskBottom && "низ"].filter(Boolean).join(", ") || "нет"}
      />
      <Row
        label="Шелк"
        value={[layers.hasSilkTop && "верх", layers.hasSilkBottom && "низ"].filter(Boolean).join(", ") || "нет"}
      />
      <Row label="Паста" value={yn(layers.hasPaste)} />

      {copper.length > 0 && (
        <>
          <SectionTitle>Мин. ширина дорожки</SectionTitle>
          {copper.map((c, i) => {
            const t = minAbove(c.traceWidthsMm, ignoreBelow);
            return <Row key={i} label={sideLabel(c.side)} value={t != null ? mm(t) : "нет дорожек"} muted={t == null} />;
          })}
        </>
      )}

      <SectionTitle>Геометрия меди</SectionTitle>
      <Row label="Мин. зазор" value={mm(geo.minClearanceMm)} muted={geo.minClearanceMm == null} />
      <Row label="Мин. ширина меди" value={mm(geo.minCopperWidthMm)} muted={geo.minCopperWidthMm == null} />
      <Row
        label="Покрытие медью"
        value={geo.copperCoveragePct != null ? `${num(geo.copperCoveragePct)} %` : "—"}
        muted={geo.copperCoveragePct == null}
      />

      <SectionTitle>Сверловка</SectionTitle>
      <Row label="Всего отверстий" value={`${drill.totalHoles}`} />
      <Row label="Мин. диаметр" value={mm(drill.minHoleMm)} />
      <Row
        label="Диаметры (инстр.)"
        value={drill.uniqueToolDiametersMm.length ? drill.uniqueToolDiametersMm.map(num).join(", ") + " мм" : "—"}
      />
      <Row label="Металлизир. / нет" value={`${drill.platedHoleCount} / ${drill.nonplatedHoleCount}`} />
      <Row label="Мин. поясок" value={mm(geo.minAnnularMm)} muted={geo.minAnnularMm == null} />
      <Row
        label="Слоты (раут)"
        value={geo.slotCount > 0 ? `${geo.slotCount}${geo.minSlotWidthMm != null ? `, мин ${num(geo.minSlotWidthMm)} мм` : ""}` : "нет"}
        muted={geo.slotCount === 0}
      />

      {(layers.hasMaskTop || layers.hasMaskBottom || layers.hasSilkTop || layers.hasSilkBottom) && (
        <>
          <SectionTitle>Маска / шелк</SectionTitle>
          <Row label="Перемычка маски" value={mm(geo.minMaskDamMm)} muted={geo.minMaskDamMm == null} />
          {(() => {
            const s = minAbove(geo.silkLineWidthsMm, ignoreBelow);
            return <Row label="Мин. линия шелка" value={s != null ? mm(s) : "—"} muted={s == null} />;
          })()}
        </>
      )}

      <SectionTitle>Совмещение</SectionTitle>
      <Row label="Выход за контур" value={mm(geo.layerOvershootMm)} muted={geo.layerOvershootMm == null} />
    </div>
  );
}
