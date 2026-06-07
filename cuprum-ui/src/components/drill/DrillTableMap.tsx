import { useRef } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { DrillClass } from "@/lib/api";
import type { DatumCorner } from "@/lib/datum";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import { useMachine } from "@/machineStore";
import { useJog } from "@/hooks/useJog";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { envelopeFit, holeTablePoints, panelOnTable } from "@/lib/tableMap";

/** Category dot colours for the table map (mirrors the handoff palette). */
const CLASS_DOT_COLOR: Record<DrillClass, string> = {
  registration: "#3b9eff",
  pth: "#e8893a",
  npth: "#9aa3af",
  mechanical: "#3fbf6f",
};

/** Margin (mm) around the travel rect in the viewBox, so overflow bars and a
 *  datum sitting on the edge stay visible. */
const MARGIN_MM = 14;

export interface DrillTableMapProps {
  /** Selected sub-plan — its holes are drawn as dots on the board. */
  plan: PanelDrillPlan;
  datum: DatumCorner;
  panelWidthMm: number;
  panelHeightMm: number;
  /** Machine travel (mm, positive) per axis. */
  maxXMm: number;
  maxYMm: number;
  /** Z travel (mm, positive) — only needed to satisfy the jog bounds; Z is not
   *  driven from the map. */
  maxZMm: number;
}

/** Board-on-bed mini-map: the machine travel (dashed), the board placed at the
 *  live spindle XY (= the prospective work zero), red overflow bars where the
 *  board would run past the travel, selected-hole dots, and the datum marker.
 *  Clicking jogs the spindle so the datum corner moves under the clicked table
 *  point ("click — bring zero here"). Any click resets a bound zero (handled by
 *  the jog, mirroring WorkZeroCard). */
export function DrillTableMap({
  plan,
  datum,
  panelWidthMm,
  panelHeightMm,
  maxXMm,
  maxYMm,
  maxZMm,
}: DrillTableMapProps) {
  const { t } = useTranslation("drill");
  const { fmtLen } = useUnitFormat();
  const svgRef = useRef<SVGSVGElement>(null);

  // Live spindle position (machine frame) = where the datum corner currently sits.
  const mposX = useMachine((s) => s.status.mpos[0]);
  const mposY = useMachine((s) => s.status.mpos[1]);
  const wposX = useMachine((s) => s.status.wpos[0]);
  const wposY = useMachine((s) => s.status.wpos[1]);

  // Work-coordinate offset (constant while jogging — both mpos & wpos move together;
  // only a re-zero changes it). Converts a machine click target → work target.
  const wcoX = mposX - wposX;
  const wcoY = mposY - wposY;

  // Jog bounds in the WORK frame that correspond to the machine travel [0,max],
  // so jogTo's clamp matches the envelope without re-clamping a valid target.
  // WCO is stable while jogging and only changes on a re-zero, which re-renders
  // (mpos/wpos are subscribed) and refreshes these bounds — same render-time-bounds
  // / click-time-target pattern as WorkZeroCard's Z click-to-move.
  const { enabled, jogTo } = useJog({
    bounds: {
      x: [0 - wcoX, maxXMm - wcoX],
      y: [0 - wcoY, maxYMm - wcoY],
      z: [-maxZMm, 0],
    },
  });

  const datumMachine = { x: mposX, y: mposY };
  const rect = panelOnTable(datumMachine, datum, panelWidthMm, panelHeightMm);
  const fit = envelopeFit(rect, maxXMm, maxYMm);
  const holes = holeTablePoints(plan, datumMachine, datum, panelWidthMm, panelHeightMm);

  // viewBox in machine mm with a margin; machine Y is up, SVG y is down → flip.
  const vbW = maxXMm + 2 * MARGIN_MM;
  const vbH = maxYMm + 2 * MARGIN_MM;
  const sx = (mx: number) => mx;
  const sy = (my: number) => maxYMm - my;

  /** A machine-coord rect → SVG <rect> attrs (top-left origin after the Y flip). */
  const svgRect = (x0: number, y0: number, x1: number, y1: number) => ({
    x: sx(x0),
    y: sy(y1),
    width: x1 - x0,
    height: y1 - y0,
  });

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!enabled) return;
    const el = svgRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // client → viewBox user coords (height:auto keeps aspect, so this is linear).
    const ux = -MARGIN_MM + ((e.clientX - r.left) / r.width) * vbW;
    const uy = -MARGIN_MM + ((e.clientY - r.top) / r.height) * vbH;
    // user → machine (undo the Y flip), clamped to the travel.
    const mx = Math.min(maxXMm, Math.max(0, ux));
    const my = Math.min(maxYMm, Math.max(0, maxYMm - uy));
    // machine → work (live WCO at click time), then jog the datum corner there.
    const { mpos, wpos } = useMachine.getState().status;
    void jogTo({ x: mx - (mpos[0] - wpos[0]), y: my - (mpos[1] - wpos[1]) });
  };

  // Overflow detail string, e.g. "X +20.0 mm, Y +5.0 mm".
  const overflowDetail = [
    fit.ox > 0 ? `X +${fmtLen(fit.ox)}` : null,
    fit.oy > 0 ? `Y +${fmtLen(fit.oy)}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  // Datum/hole marker sizes scale with travel so they stay visible at any envelope.
  const dotR = Math.max(maxXMm, maxYMm) * 0.006;
  const datumR = Math.max(maxXMm, maxYMm) * 0.014;

  return (
    <div className="flex flex-col gap-1.5">
      <svg
        ref={svgRef}
        viewBox={`${-MARGIN_MM} ${-MARGIN_MM} ${vbW} ${vbH}`}
        onClick={onClick}
        className={`block w-full rounded-lg border border-border bg-[#0c0e11] ${enabled ? "cursor-pointer" : ""}`}
        style={{ height: "auto" }}
      >
        {/* Machine travel rect (dashed) */}
        <rect
          {...svgRect(0, 0, maxXMm, maxYMm)}
          fill="none"
          stroke="#3a4250"
          strokeWidth={1}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
        />

        {/* Board rect (copper) */}
        <rect
          {...svgRect(rect.x0, rect.y0, rect.x1, rect.y1)}
          fill="rgba(224,123,62,0.12)"
          stroke="#e07b3e"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />

        {/* Overflow bars (board portions past the travel) */}
        {rect.x1 > maxXMm && (
          <rect {...svgRect(maxXMm, rect.y0, rect.x1, rect.y1)} fill="rgba(220,70,70,0.4)" />
        )}
        {rect.x0 < 0 && (
          <rect {...svgRect(rect.x0, rect.y0, 0, rect.y1)} fill="rgba(220,70,70,0.4)" />
        )}
        {rect.y1 > maxYMm && (
          <rect {...svgRect(rect.x0, maxYMm, rect.x1, rect.y1)} fill="rgba(220,70,70,0.4)" />
        )}
        {rect.y0 < 0 && (
          <rect {...svgRect(rect.x0, rect.y0, rect.x1, 0)} fill="rgba(220,70,70,0.4)" />
        )}

        {/* Selected-hole dots */}
        {holes.map((h, i) => (
          <circle
            key={i}
            cx={sx(h.x)}
            cy={sy(h.y)}
            r={dotR}
            fill={CLASS_DOT_COLOR[h.class]}
            opacity={0.7}
          />
        ))}

        {/* Datum marker (copper dot + ring) at the live spindle position */}
        <circle cx={sx(mposX)} cy={sy(mposY)} r={datumR} fill="#e07b3e" />
        <circle
          cx={sx(mposX)}
          cy={sy(mposY)}
          r={datumR * 1.85}
          fill="none"
          stroke="#e07b3e"
          strokeWidth={1.2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {/* Caption */}
      <p className="text-[10px] text-muted-foreground/70">
        {t("tableMap.caption", { w: fmtLen(maxXMm), h: fmtLen(maxYMm) })}
      </p>

      {/* Fit status */}
      {fit.ok ? (
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span>{t("tableMap.fits")}</span>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{t("tableMap.overflow", { detail: overflowDetail })}</span>
        </div>
      )}
    </div>
  );
}
