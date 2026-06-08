import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import type { DatumCorner } from "@/lib/datum";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import { useMachine } from "@/machineStore";
import { useJog } from "@/hooks/useJog";
import { useUnitFormat } from "@/i18n/useUnitFormat";
import { envelopeFit, holeTablePoints, panelOnTable } from "@/lib/tableMap";
import { DRILL_CLASS_COLOR } from "@/lib/drillClassColor";

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

  // Hover crosshair: the prospective click target in the machine frame plus the
  // pointer pixel position (relative to the svg) for the floating X/Y label, and
  // edge flags so the label flips away from the right/bottom edge.
  const [hover, setHover] = useState<{
    mx: number;
    my: number;
    px: number;
    py: number;
    flipX: boolean;
    flipY: boolean;
  } | null>(null);

  // Live spindle position (machine frame) = where the datum corner currently sits.
  const mposX = useMachine((s) => s.status.mpos[0]);
  const mposY = useMachine((s) => s.status.mpos[1]);

  // Machine-frame jog bounds (= the travel envelope), matching WorkZeroCard and
  // useJog's contract: jogTo's clampWork() converts the work-space target to the
  // machine frame via the live WCO and clamps it against THESE machine bounds.
  // (Passing work-frame bounds here double-applied the WCO, clamping the Y target
  // back to the current position so a click only moved X — see #507.)
  const { enabled, jogTo } = useJog({
    bounds: {
      x: [0, maxXMm],
      y: [0, maxYMm],
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

  /** Pointer event → prospective machine target (clamped to travel) + pointer px
   *  relative to the svg. mx/my are machine-frame coords; onClick converts to the
   *  work frame before jogging, but the datum corner ends up at exactly mx/my — so
   *  the hover label (which shows mx/my) matches where the click drives the spindle. */
  const pointerTarget = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    // client → viewBox user coords (height:auto keeps aspect, so this is linear).
    const ux = -MARGIN_MM + (px / r.width) * vbW;
    const uy = -MARGIN_MM + (py / r.height) * vbH;
    // user → machine (undo the Y flip), clamped to the travel.
    const mx = Math.min(maxXMm, Math.max(0, ux));
    const my = Math.min(maxYMm, Math.max(0, maxYMm - uy));
    return { mx, my, px, py, w: r.width, h: r.height };
  };

  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!enabled) return;
    const { mx, my } = pointerTarget(e);
    // machine → work (live WCO at click time), then jog the datum corner there.
    const { mpos, wpos } = useMachine.getState().status;
    void jogTo({ x: mx - (mpos[0] - wpos[0]), y: my - (mpos[1] - wpos[1]) });
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const { mx, my, px, py, w, h } = pointerTarget(e);
    setHover({ mx, my, px, py, flipX: px > w * 0.62, flipY: py > h * 0.78 });
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
      <div className="relative">
      <svg
        viewBox={`${-MARGIN_MM} ${-MARGIN_MM} ${vbW} ${vbH}`}
        onClick={onClick}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        className={`block w-full rounded-lg border border-border bg-[#0c0e11] ${enabled ? "cursor-crosshair" : "cursor-not-allowed"}`}
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
            fill={DRILL_CLASS_COLOR[h.class]}
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

        {/* Hover crosshair: full-span guides through the prospective target,
         *  clipped to the travel rect (informational — never blocks the click). */}
        {hover && (
          <g pointerEvents="none">
            <line
              x1={sx(hover.mx)}
              y1={sy(0)}
              x2={sx(hover.mx)}
              y2={sy(maxYMm)}
              stroke="#9aa4b2"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.55}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={sx(0)}
              y1={sy(hover.my)}
              x2={sx(maxXMm)}
              y2={sy(hover.my)}
              stroke="#9aa4b2"
              strokeWidth={1}
              strokeDasharray="3 3"
              opacity={0.55}
              vectorEffect="non-scaling-stroke"
            />
            <circle
              cx={sx(hover.mx)}
              cy={sy(hover.my)}
              r={datumR * 0.8}
              fill="none"
              stroke="#cfd6df"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        )}
      </svg>

      {/* Floating X/Y readout following the cursor (machine frame = where the
       *  datum corner jogs to on click). Flips away from the right/bottom edge. */}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 flex gap-2 rounded-md border border-border bg-background/90 px-1.5 py-0.5 font-mono text-[11px] tabular-nums shadow-sm backdrop-blur-sm"
          style={{
            left: hover.px,
            top: hover.py,
            transform: `translate(${hover.flipX ? "calc(-100% - 10px)" : "10px"}, ${
              hover.flipY ? "calc(-100% - 10px)" : "10px"
            })`,
          }}
        >
          <span className="text-axis-x">X {fmtLen(hover.mx)}</span>
          <span className="text-axis-y">Y {fmtLen(hover.my)}</span>
        </div>
      )}
      </div>

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
