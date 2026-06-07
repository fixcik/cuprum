import { useEffect, useId, useMemo, useRef, useState } from "react";
import { RULER_TOP, RULER_LEFT } from "@/components/editor/canvasStyle";
import { gridSteps, ticksFor } from "@/lib/canvasTicks";

/** Screen-space viewport descriptor: how many px one mm spans, and the screen-px
 *  position of mm 0. `screenX(mm) = originX + mm * pxPerMm`. Both canvases keep mm
 *  increasing left/down across the rulers (the design preview anchors its rulers to
 *  the board edge via `anchorMm`), so a single increasing axis covers both. */
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
  /** Cursor position in screen px (for the crosshair/readout). Null when off-canvas.
   *  `snapped` marks the point locked onto a feature/edge/corner → a lock ring is
   *  drawn at the crosshair intersection. */
  hover?: { x: number; y: number; snapped?: boolean } | null;
  /** Draw the origin (0,0) marker. Default true. */
  showOrigin?: boolean;
  /** Ruler band thickness in px (defaults to the shared RULER_TOP/RULER_LEFT). The
   *  design preview keeps its slimmer 20px bands; the panel uses the defaults. */
  rulerTop?: number;
  rulerLeft?: number;
  /** Accent for the extent highlight + edge reticles + origin marker. `"copper"`
   *  (default) suits the panel blank; `"muted"` is a neutral dark tint for the
   *  busy design preview, where copper fought the PCB colours. */
  extentVariant?: "copper" | "muted";
  /** When a datum corner is on the right/bottom, the displayed tick/readout value
   *  counts away from that corner (negating the signed offset from anchorMm) so the
   *  panel always reads 0 → W from the datum corner toward the opposite edge.
   *  Crosshair + caret positions are NEVER changed — only the displayed number.
   *  Default {x:false, y:false}. */
  axisFlip?: { x: boolean; y: boolean };
}

// Copper = action/cursor (hover crosshair + ruler cursor arrows) and the blank
// projection highlight ("where's my blank"). Structure (origin marker)
// is neutral — see MUTED_* below.
const COPPER = "hsl(var(--primary))";
const COPPER_14 = "hsl(var(--primary) / 0.14)";
const COPPER_70 = "hsl(var(--primary) / 0.7)";
const MUTED = "hsl(var(--muted-foreground))";

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
  hover = null,
  showOrigin = true,
  rulerTop = RULER_TOP,
  rulerLeft = RULER_LEFT,
  extentVariant = "copper",
  axisFlip = { x: false, y: false },
}: RulersOverlayProps) {
  // Strip the colons React's useId emits — they trip up `url(#…)` fragment refs
  // in some WebKit builds (WKWebView).
  const clipId = `rul-${useId().replace(/:/g, "")}`;
  const { pxPerMm, originX, originY } = viewport;
  const ready = pxPerMm > 0 && size.w > 0 && size.h > 0;

  // Always-on axis readout: the overlay tracks the pointer itself (own listener, so
  // the host never re-renders on a bare hover) and shows the coordinate under the
  // cursor on each ruler. Distinct from the opt-in crosshair (`hover`) — no full
  // cross lines, just value pills on the scales. Coalesced to one update per frame.
  const svgRef = useRef<SVGSVGElement>(null);
  const [axisCursor, setAxisCursor] = useState<{ x: number; y: number } | null>(null);
  const axisRaf = useRef<number | null>(null);
  const axisPending = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const el = svgRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      axisPending.current = x >= 0 && y >= 0 && x <= r.width && y <= r.height ? { x, y } : null;
      if (axisRaf.current != null) return;
      axisRaf.current = requestAnimationFrame(() => {
        axisRaf.current = null;
        setAxisCursor(axisPending.current);
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (axisRaf.current != null) cancelAnimationFrame(axisRaf.current);
    };
  }, []);

  const screenX = (mm: number) => originX + mm * pxPerMm;
  const screenY = (mm: number) => originY + mm * pxPerMm;
  const mmFromX = (px: number) => (px - originX) / pxPerMm;
  const mmFromY = (px: number) => (px - originY) / pxPerMm;

  const { minor, labelEvery } = useMemo(
    () => (ready ? gridSteps(pxPerMm) : { minor: 0, labelEvery: 1 }),
    [ready, pxPerMm],
  );
  // Tick arrays depend only on the viewport/size/anchor — NOT on the cursor — so
  // memoise them (and the tick JSX below). On a bare hover the parent re-renders
  // but the dozens of tick <g>/<line>/<text> elements keep stable identity and
  // React skips reconciling that subtree (the dominant per-frame cost otherwise).
  const vTicks = useMemo(
    () => (ready ? ticksFor(anchorMm.x, mmFromX(rulerLeft), mmFromX(size.w), minor, labelEvery) : []),
    [ready, anchorMm.x, originX, pxPerMm, rulerLeft, size.w, minor, labelEvery],
  );
  const hTicks = useMemo(
    () => (ready ? ticksFor(anchorMm.y, mmFromY(rulerTop), mmFromY(size.h), minor, labelEvery) : []),
    [ready, anchorMm.y, originY, pxPerMm, rulerTop, size.h, minor, labelEvery],
  );

  // Screen span of an mm interval (left edge + positive width).
  const spanX = (a: number, b: number) => ({ x: screenX(a), w: (b - a) * pxPerMm });
  const spanY = (a: number, b: number) => ({ y: screenY(a), h: (b - a) * pxPerMm });
  // Extent highlight / reticles / origin accent. Copper for the panel blank; a
  // neutral dark tint for the design preview, where copper clashed with the board.
  const accent = extentVariant === "muted" ? "hsl(var(--muted-foreground))" : COPPER;
  const accentFill = extentVariant === "muted" ? "hsl(var(--muted-foreground) / 0.12)" : COPPER_14;
  // Origin (ruler "0") marker sits at the anchor — the board corner / panel origin.
  const ax = screenX(anchorMm.x);
  const ay = screenY(anchorMm.y);

  const inPlot = hover && hover.x > rulerLeft && hover.y > rulerTop;

  // When a datum is on the right/bottom edge, displayed distances count from that
  // corner toward the opposite edge. `d` is the raw distance from the anchor; the
  // flip mirrors it against the extent span so the panel always reads 0→W / 0→H
  // from the datum corner. Only the label/readout value changes — screen position
  // of ticks and crosshair lines are unaffected.
  // `d` is the SIGNED offset (mm) from the anchor (datum corner). For a flipped
  // axis the displayed value is the distance from the datum corner toward the
  // opposite edge, i.e. -d (points into the panel are at negative offset when the
  // anchor is on the right/bottom). Non-flipped axes display the offset as-is.
  const displayX = (d: number) => (axisFlip.x ? -d : d);
  const displayY = (d: number) => (axisFlip.y ? -d : d);

  // Memoised tick JSX — stable across cursor-only re-renders (see vTicks note).
  const topTicksEls = useMemo(
    () =>
      vTicks.map((tk) => {
        const x = screenX(tk.mm);
        if (x < rulerLeft || x > size.w) return null;
        return (
          <g key={`tv${tk.mm}`}>
            <line
              x1={x}
              y1={tk.major ? rulerTop - 9 : rulerTop - 5}
              x2={x}
              y2={rulerTop}
              style={{ stroke: `hsl(var(--muted-foreground) / ${tk.major ? 0.7 : 0.4})` }}
              strokeWidth={1}
            />
            {tk.major && x > rulerLeft + 6 && (
              <text x={x + 3} y={9} style={{ fill: "hsl(var(--muted-foreground))", fontSize: "9px" }}>
                {fmtTick(displayX(tk.label))}
              </text>
            )}
          </g>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vTicks, originX, pxPerMm, rulerLeft, rulerTop, size.w, axisFlip.x],
  );
  const leftTicksEls = useMemo(
    () =>
      hTicks.map((tk) => {
        const y = screenY(tk.mm);
        if (y < rulerTop || y > size.h) return null;
        return (
          <g key={`th${tk.mm}`}>
            <line
              x1={tk.major ? rulerLeft - 9 : rulerLeft - 5}
              y1={y}
              x2={rulerLeft}
              y2={y}
              style={{ stroke: `hsl(var(--muted-foreground) / ${tk.major ? 0.7 : 0.4})` }}
              strokeWidth={1}
            />
            {tk.major && y > rulerTop + 6 && (
              <text
                x={9}
                y={y + 3}
                transform={`rotate(-90 9 ${y + 3})`}
                textAnchor="start"
                style={{ fill: "hsl(var(--muted-foreground))", fontSize: "9px" }}
              >
                {fmtTick(displayY(tk.label))}
              </text>
            )}
          </g>
        );
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hTicks, originY, pxPerMm, rulerLeft, rulerTop, size.h, axisFlip.y],
  );

  // Readout chip placement: nudge off the cursor, flip near the right/bottom edge.
  let readout: { x: number; y: number; w: number; text: string } | null = null;
  if (ready && inPlot && hover) {
    // Coordinates relative to the ruler anchor, with optional axis flip, so the
    // readout matches the tick labels regardless of which datum corner is active.
    const rawX = mmFromX(hover.x) - anchorMm.x;
    const rawY = mmFromY(hover.y) - anchorMm.y;
    const text = `X ${fmt(displayX(rawX))} · Y ${fmt(displayY(rawY))}`;
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
      ref={svgRef}
      className="pointer-events-none absolute inset-0"
      width={size.w}
      height={size.h}
      style={{ overflow: "hidden" }}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={rulerLeft} y={rulerTop} width={size.w - rulerLeft} height={size.h - rulerTop} />
        </clipPath>
      </defs>

      {/* Plot-area guides: clipped so nothing bleeds onto the ruler bands. */}
      <g clipPath={`url(#${clipId})`}>
        {showOrigin && (
          <g>
            <line x1={ax - 7} y1={ay} x2={ax + 7} y2={ay} stroke={MUTED} strokeWidth={1} />
            <line x1={ax} y1={ay - 7} x2={ax} y2={ay + 7} stroke={MUTED} strokeWidth={1} />
            <text x={ax + 5} y={ay - 4} style={{ fill: "hsl(var(--muted-foreground))", fontSize: "10px" }}>
              0,0
            </text>
          </g>
        )}

        {inPlot && hover && (
          <>
            <g stroke={COPPER_70} strokeWidth={1} strokeDasharray="4 3">
              <line x1={hover.x} y1={rulerTop} x2={hover.x} y2={size.h} />
              <line x1={rulerLeft} y1={hover.y} x2={size.w} y2={hover.y} />
            </g>
            {/* Lock ring when the crosshair snapped onto a feature/edge/corner. */}
            {hover.snapped && (
              <circle cx={hover.x} cy={hover.y} r={6} fill="none" stroke={COPPER} strokeWidth={1.5} strokeDasharray="3 2" />
            )}
          </>
        )}
      </g>

      {/* Ruler bands (opaque) — drawn over the plot so content can't show through. */}
      <rect x={0} y={0} width={size.w} height={rulerTop} fill="hsl(var(--card))" />
      <rect x={0} y={0} width={rulerLeft} height={size.h} fill="hsl(var(--card))" />

      {/* Blank/board extent highlight — the ruler "sticks" to the square. */}
      {extentMm && (() => {
        const ex = spanX(extentMm.x, extentMm.x + extentMm.w);
        const ey = spanY(extentMm.y, extentMm.y + extentMm.h);
        return (
        <>
          <rect x={ex.x} y={0} width={ex.w} height={rulerTop} fill={accentFill} />
          <rect x={0} y={ey.y} width={rulerLeft} height={ey.h} fill={accentFill} />
          {/* Copper reticles at the extent edges (0 and W / H). */}
          {[extentMm.x, extentMm.x + extentMm.w].map((mm, i) => {
            const x = screenX(mm);
            if (x < rulerLeft || x > size.w) return null;
            return <line key={`ev${i}`} x1={x} y1={0} x2={x} y2={rulerTop} stroke={accent} strokeWidth={1.5} />;
          })}
          {[extentMm.y, extentMm.y + extentMm.h].map((mm, i) => {
            const y = screenY(mm);
            if (y < rulerTop || y > size.h) return null;
            return <line key={`eh${i}`} x1={0} y1={y} x2={rulerLeft} y2={y} stroke={accent} strokeWidth={1.5} />;
          })}
        </>
        );
      })()}

      {/* Top ruler ticks + labels (memoised — see topTicksEls). */}
      {topTicksEls}

      {/* Left ruler ticks + labels, rotated (memoised — see leftTicksEls). */}
      {leftTicksEls}

      {/* Cursor arrow markers on the rulers. */}
      {inPlot && hover && (
        <g fill={COPPER}>
          <path d={`M ${hover.x} ${rulerTop} L ${hover.x - 4} ${rulerTop - 6} L ${hover.x + 4} ${rulerTop - 6} Z`} />
          <path d={`M ${rulerLeft} ${hover.y} L ${rulerLeft - 6} ${hover.y - 4} L ${rulerLeft - 6} ${hover.y + 4} Z`} />
        </g>
      )}

      {/* Corner square + band edges. */}
      <rect x={0} y={0} width={rulerLeft} height={rulerTop} fill="hsl(var(--card))" />
      <line x1={rulerLeft} y1={0} x2={rulerLeft} y2={size.h} stroke="hsl(var(--border))" strokeWidth={1} />
      <line x1={0} y1={rulerTop} x2={size.w} y2={rulerTop} stroke="hsl(var(--border))" strokeWidth={1} />

      {/* Always-on axis carets: a light marker runs along each ruler at the cursor
          so you can line the position up against the ticks without enabling the
          crosshair. No text — the carets alone stay quiet over busy content. */}
      {axisCursor && axisCursor.x > rulerLeft && axisCursor.y > rulerTop && (
        <g fill={accent}>
          {/* Top ruler caret */}
          <path d={`M ${axisCursor.x} ${rulerTop} L ${axisCursor.x - 4} ${rulerTop - 6} L ${axisCursor.x + 4} ${rulerTop - 6} Z`} />
          {/* Left ruler caret */}
          <path d={`M ${rulerLeft} ${axisCursor.y} L ${rulerLeft - 6} ${axisCursor.y - 4} L ${rulerLeft - 6} ${axisCursor.y + 4} Z`} />
        </g>
      )}

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
