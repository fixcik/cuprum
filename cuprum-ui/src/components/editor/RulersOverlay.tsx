import { useId } from "react";
import { RULER_TOP, RULER_LEFT } from "@/components/editor/canvasStyle";
import { gridSteps, ticksFor } from "@/lib/canvasTicks";

/** Screen-space viewport descriptor: how many px one mm spans, and the screen-px
 *  position of the world origin (mm 0,0). `screenX(mm) = originX + mm * pxPerMm`. */
export interface Viewport {
  pxPerMm: number;
  originX: number;
  originY: number;
}

export interface RulersOverlayProps {
  /** Live viewport transform (px/mm + origin in screen px). */
  viewport: Viewport;
  /** Viewport size in CSS px. */
  size: { w: number; h: number };
  /** Active-unit length formatter (e.g. useUnitFormat().fmtLen). */
  fmt: (mm: number) => string;
  /** Ruler "0" anchor in mm (default 0,0 — the world origin). */
  anchorMm?: { x: number; y: number };
  /** Extent (mm) highlighted on the rulers — the blank/board, so the scale
   *  "sticks" to it at any zoom. Null hides the highlight. */
  extentMm?: { x: number; y: number; w: number; h: number } | null;
  /** Machine work-area limit (mm) drawn as a dashed rectangle from the origin. */
  workAreaMm?: { w: number; h: number } | null;
  /** Localised label for the work-area rectangle. */
  workAreaLabel?: string;
  /** Cursor position in screen px (for the crosshair/readout). Null when off-canvas. */
  hover?: { x: number; y: number } | null;
  /** Draw the origin (0,0) marker. Default true. */
  showOrigin?: boolean;
}

const COPPER = "hsl(var(--primary))";
const COPPER_14 = "hsl(var(--primary) / 0.14)";
const COPPER_50 = "hsl(var(--primary) / 0.5)";
const COPPER_70 = "hsl(var(--primary) / 0.7)";
const READOUT_BG = "hsl(222 16% 9% / 0.92)";
const READOUT_FG = "rgba(255,255,255,0.95)";

/** Format a mm value compactly for tick labels: 0.5, 12.5, 50 (no trailing zeros). */
function fmtTick(v: number): string {
  if (Math.abs(v) < 1e-9) return "0";
  return parseFloat(v.toFixed(3)).toString();
}

/** Edge-pinned rulers + mm grid alignment + hover crosshair/readout, rendered as a
 *  screen-space SVG overlay above any canvas (Konva or SVG). Rendering tech is
 *  irrelevant: it's driven purely by the `viewport` descriptor, so both the panel
 *  blank (Konva) and the design preview can share one ruler implementation. The
 *  overlay never intercepts pointer events. */
export function RulersOverlay({
  viewport,
  size,
  fmt,
  anchorMm = { x: 0, y: 0 },
  extentMm = null,
  workAreaMm = null,
  workAreaLabel,
  hover = null,
  showOrigin = true,
}: RulersOverlayProps) {
  // Strip the colons React's useId emits — they trip up `url(#…)` fragment refs
  // in some WebKit builds (WKWebView).
  const clipId = `rul-${useId().replace(/:/g, "")}`;
  const { pxPerMm, originX, originY } = viewport;
  const ready = pxPerMm > 0 && size.w > 0 && size.h > 0;

  const screenX = (mm: number) => originX + mm * pxPerMm;
  const screenY = (mm: number) => originY + mm * pxPerMm;
  const mmFromX = (px: number) => (px - originX) / pxPerMm;
  const mmFromY = (px: number) => (px - originY) / pxPerMm;

  const { minor, labelEvery } = ready ? gridSteps(pxPerMm) : { minor: 0, labelEvery: 1 };
  const vTicks = ready ? ticksFor(anchorMm.x, mmFromX(RULER_LEFT), mmFromX(size.w), minor, labelEvery) : [];
  const hTicks = ready ? ticksFor(anchorMm.y, mmFromY(RULER_TOP), mmFromY(size.h), minor, labelEvery) : [];

  const inPlot = hover && hover.x > RULER_LEFT && hover.y > RULER_TOP;

  // Readout chip placement: nudge off the cursor, flip near the right/bottom edge.
  let readout: { x: number; y: number; w: number; text: string } | null = null;
  if (ready && inPlot && hover) {
    const text = `X ${fmt(mmFromX(hover.x))} · Y ${fmt(mmFromY(hover.y))}`;
    const w = text.length * 6.2 + 16; // rough monospace-ish width estimate
    let x = hover.x + 14;
    let y = hover.y + 14;
    if (x + w > size.w) x = hover.x - w - 14;
    if (y + 22 > size.h) y = hover.y - 30;
    readout = { x, y, w, text };
  }

  if (!ready) return null;

  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={size.w}
      height={size.h}
      style={{ overflow: "hidden" }}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={RULER_LEFT} y={RULER_TOP} width={size.w - RULER_LEFT} height={size.h - RULER_TOP} />
        </clipPath>
      </defs>

      {/* Plot-area guides: clipped so nothing bleeds onto the ruler bands. */}
      <g clipPath={`url(#${clipId})`}>
        {workAreaMm && (
          <>
            <rect
              x={screenX(0)}
              y={screenY(0)}
              width={workAreaMm.w * pxPerMm}
              height={workAreaMm.h * pxPerMm}
              fill="none"
              stroke={COPPER_50}
              strokeWidth={1}
              strokeDasharray="6 4"
            />
            {workAreaLabel && workAreaMm.w * pxPerMm > 60 && (
              <text
                x={screenX(0) + 4}
                y={screenY(0) + 12}
                style={{ fill: COPPER_70, fontSize: "10px" }}
              >
                {workAreaLabel}
              </text>
            )}
          </>
        )}

        {showOrigin && (
          <g>
            <line x1={screenX(0) - 7} y1={screenY(0)} x2={screenX(0) + 7} y2={screenY(0)} stroke={COPPER} strokeWidth={1} />
            <line x1={screenX(0)} y1={screenY(0) - 7} x2={screenX(0)} y2={screenY(0) + 7} stroke={COPPER} strokeWidth={1} />
            <text x={screenX(0) + 5} y={screenY(0) - 4} style={{ fill: "hsl(var(--muted-foreground))", fontSize: "10px" }}>
              0,0
            </text>
          </g>
        )}

        {inPlot && hover && (
          <g stroke={COPPER_70} strokeWidth={1} strokeDasharray="4 3">
            <line x1={hover.x} y1={RULER_TOP} x2={hover.x} y2={size.h} />
            <line x1={RULER_LEFT} y1={hover.y} x2={size.w} y2={hover.y} />
          </g>
        )}
      </g>

      {/* Ruler bands (opaque) — drawn over the plot so content can't show through. */}
      <rect x={0} y={0} width={size.w} height={RULER_TOP} fill="hsl(var(--card))" />
      <rect x={0} y={0} width={RULER_LEFT} height={size.h} fill="hsl(var(--card))" />

      {/* Blank/board extent highlight — the ruler "sticks" to the square. */}
      {extentMm && (
        <>
          <rect x={screenX(extentMm.x)} y={0} width={extentMm.w * pxPerMm} height={RULER_TOP} fill={COPPER_14} />
          <rect x={0} y={screenY(extentMm.y)} width={RULER_LEFT} height={extentMm.h * pxPerMm} fill={COPPER_14} />
          {/* Copper reticles at the extent edges (0 and W / H). */}
          {[extentMm.x, extentMm.x + extentMm.w].map((mm, i) => {
            const x = screenX(mm);
            if (x < RULER_LEFT || x > size.w) return null;
            return <line key={`ev${i}`} x1={x} y1={0} x2={x} y2={RULER_TOP} stroke={COPPER} strokeWidth={1.5} />;
          })}
          {[extentMm.y, extentMm.y + extentMm.h].map((mm, i) => {
            const y = screenY(mm);
            if (y < RULER_TOP || y > size.h) return null;
            return <line key={`eh${i}`} x1={0} y1={y} x2={RULER_LEFT} y2={y} stroke={COPPER} strokeWidth={1.5} />;
          })}
        </>
      )}

      {/* Top ruler ticks + labels. */}
      {vTicks.map((tk) => {
        const x = screenX(tk.mm);
        if (x < RULER_LEFT || x > size.w) return null;
        return (
          <g key={`tv${tk.mm}`}>
            <line
              x1={x}
              y1={tk.major ? RULER_TOP - 9 : RULER_TOP - 5}
              x2={x}
              y2={RULER_TOP}
              style={{ stroke: `hsl(var(--muted-foreground) / ${tk.major ? 0.7 : 0.4})` }}
              strokeWidth={1}
            />
            {tk.major && x > RULER_LEFT + 6 && (
              <text x={x + 3} y={9} style={{ fill: "hsl(var(--muted-foreground))", fontSize: "9px" }}>
                {fmtTick(tk.label)}
              </text>
            )}
          </g>
        );
      })}

      {/* Left ruler ticks + labels (rotated). */}
      {hTicks.map((tk) => {
        const y = screenY(tk.mm);
        if (y < RULER_TOP || y > size.h) return null;
        return (
          <g key={`th${tk.mm}`}>
            <line
              x1={tk.major ? RULER_LEFT - 9 : RULER_LEFT - 5}
              y1={y}
              x2={RULER_LEFT}
              y2={y}
              style={{ stroke: `hsl(var(--muted-foreground) / ${tk.major ? 0.7 : 0.4})` }}
              strokeWidth={1}
            />
            {tk.major && y > RULER_TOP + 6 && (
              <text
                x={9}
                y={y + 3}
                transform={`rotate(-90 9 ${y + 3})`}
                textAnchor="start"
                style={{ fill: "hsl(var(--muted-foreground))", fontSize: "9px" }}
              >
                {fmtTick(tk.label)}
              </text>
            )}
          </g>
        );
      })}

      {/* Cursor arrow markers on the rulers. */}
      {inPlot && hover && (
        <g fill={COPPER}>
          <path d={`M ${hover.x} ${RULER_TOP} L ${hover.x - 4} ${RULER_TOP - 6} L ${hover.x + 4} ${RULER_TOP - 6} Z`} />
          <path d={`M ${RULER_LEFT} ${hover.y} L ${RULER_LEFT - 6} ${hover.y - 4} L ${RULER_LEFT - 6} ${hover.y + 4} Z`} />
        </g>
      )}

      {/* Corner square + band edges. */}
      <rect x={0} y={0} width={RULER_LEFT} height={RULER_TOP} fill="hsl(var(--card))" />
      <line x1={RULER_LEFT} y1={0} x2={RULER_LEFT} y2={size.h} stroke="hsl(var(--border))" strokeWidth={1} />
      <line x1={0} y1={RULER_TOP} x2={size.w} y2={RULER_TOP} stroke="hsl(var(--border))" strokeWidth={1} />

      {/* Hover readout chip — over everything. */}
      {readout && (
        <g transform={`translate(${readout.x} ${readout.y})`}>
          <rect x={0} y={0} width={readout.w} height={22} rx={5} style={{ fill: READOUT_BG, stroke: "hsl(var(--border))" }} />
          <text x={8} y={15} style={{ fill: READOUT_FG, fontSize: "11px", fontVariantNumeric: "tabular-nums" }}>
            {readout.text}
          </text>
        </g>
      )}
    </svg>
  );
}
