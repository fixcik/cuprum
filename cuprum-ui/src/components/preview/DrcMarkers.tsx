import { memo } from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useTranslation } from "react-i18next";
import type { Severity } from "@/lib/feasibility";
import { SEVERITY } from "@/lib/severity";
import { boxPlacement, circlePlacement, dimTicks, hitboxPlacement, markerPaintOrder } from "@/lib/drcMarkers";

/** A DRC hotspot projected to screen px: a dimension line a→b with the value at
 *  its midpoint, plus the description for the hover card. */
export interface ProjectedMarker {
  key: string;
  ax: number;
  ay: number;
  bx: number;
  by: number;
  mx: number;
  my: number;
  value: string; // e.g. "0.08 mm" — drawn on the focused marker
  label: string;
  limit: string;
  detail?: string;
  severity: Severity;
  focused: boolean;
  /** "dim" = dimension line a→b (gaps); "box" = rectangle around a..b (a thin
   *  feature or cluster); "circle" = ring around a hole (a..b = bbox); "line" =
   *  colour-highlight the stroke a→b itself at its width; "hover" = invisible
   *  hover region (a..b bbox) that just carries a tooltip for a line cluster. */
  shape?: "dim" | "box" | "circle" | "line" | "hover";
  /** Stroke width in screen px (for the "line" highlight). */
  widthPx?: number;
  /** Override for the "line" highlight stroke colour (default = blue silk tint). */
  lineColor?: string;
}

/** A DRC marker in board mm (before projection) — what the preview is handed. */
export interface DrcMarkerInput {
  key: string;
  a: [number, number];
  b: [number, number];
  value: string;
  label: string;
  limit: string;
  detail?: string;
  severity: Severity;
  focused: boolean;
  shape?: "dim" | "box" | "circle" | "line" | "hover";
  /** Stroke width in board mm (for the "line" highlight; projected to px). */
  widthMm?: number;
  /** Override for the "line" highlight stroke colour (default = blue silk tint). */
  lineColor?: string;
}

/** Colour for the "line" highlight — a vivid blue that stays legible over BOTH the
 *  white silk it overlays and the green board behind it, even zoomed out, without
 *  the alarm of red (grey washed out at distance). */
const LINE_HIGHLIGHT = "#3b82f6";

/** DRC dimension markers overlaid on the 2D preview: a coloured dimension line
 *  with end ticks at each issue, the value drawn on the focused one, and a hover
 *  card describing the problem. Screen-space; the parent projects mm→px.
 *
 *  Memoised: the design preview re-renders every frame while the hover crosshair
 *  tracks the pointer, but the markers/size only change on a real view change.
 *  Without memo the whole (potentially ~500-hotspot) overlay re-rasterized each
 *  cursor frame at high zoom — the source of the zoom artifacts. */
export const DrcMarkers = memo(function DrcMarkers({
  markers,
  width,
  height,
  pad = 0,
}: {
  markers: ProjectedMarker[];
  width: number;
  height: number;
  /** Inset (px) reserved by the edge rulers on the top & left — markers are clipped
   *  out of that band so a hotspot near the edge never paints over the ruler. */
  pad?: number;
}) {
  const { t } = useTranslation("common");
  if (markers.length === 0) return null;
  return (
    // Clip the whole overlay out of the top/left ruler band — a CSS clip-path
    // constrains BOTH the SVG marker paint AND the HTML tooltip hitboxes (and
    // their hit-testing), so a hotspot near the edge never reaches over a ruler.
    <div
      className="pointer-events-none absolute inset-0"
      style={pad > 0 ? { clipPath: `inset(${pad}px 0 0 ${pad}px)` } : undefined}
    >
      <svg width={width} height={height} className="absolute inset-0">
        {markerPaintOrder(markers).map((m) => {
          const c = SEVERITY[m.severity].hsl;
          if (m.shape === "hover") {
            if (!m.focused) return null;
            // Focused cluster: a box (+ width label) so ‹› shows where it landed.
            const hb = boxPlacement(m, 6, 16);
            const hcol = SEVERITY[m.severity].hsl;
            return (
              <g key={m.key}>
                <rect
                  x={hb.x}
                  y={hb.y}
                  width={hb.w}
                  height={hb.h}
                  rx={3}
                  fill="none"
                  stroke={hcol}
                  strokeWidth={2}
                />
                <text
                  x={hb.labelX}
                  y={hb.labelY}
                  style={{
                    fill: hcol,
                    fontSize: "11px",
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    paintOrder: "stroke",
                    stroke: "hsl(var(--background))",
                    strokeWidth: 3,
                    strokeLinejoin: "round",
                  }}
                >
                  {m.value}
                </text>
              </g>
            );
          }
          if (m.shape === "line") {
            // Colour-highlight the failing stroke itself, at its width (min 2px so
            // a hair-thin line still reads). No value label / hitbox — it's a bulk
            // highlight, not an inspectable single marker.
            return (
              <line
                key={m.key}
                x1={m.ax}
                y1={m.ay}
                x2={m.bx}
                y2={m.by}
                stroke={m.lineColor ?? LINE_HIGHLIGHT}
                strokeWidth={Math.max(m.widthPx ?? 0, 2.5)}
                strokeLinecap="round"
              />
            );
          }
          const tick = m.focused ? 7 : 4;
          const sw = m.focused ? 2 : 1.25;
          if (m.shape === "circle") {
            // Ring around a hole (a..b = its bbox). Drawn thick so it's visible,
            // solid on an error (or when focused), dashed otherwise.
            const cp = circlePlacement(m, 8);
            const solid = m.focused || m.severity === "block";
            const cw = m.focused ? 2.75 : 2;
            return (
              <g key={m.key} opacity={m.focused ? 1 : 0.85}>
                <circle
                  cx={cp.cx}
                  cy={cp.cy}
                  r={cp.r}
                  fill="none"
                  stroke={c}
                  strokeWidth={cw}
                  strokeDasharray={solid ? undefined : "4 2"}
                />
                {m.focused && (
                  <text
                    x={cp.labelX}
                    y={cp.labelY}
                    style={{
                      fill: c,
                      fontSize: "11px",
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                      paintOrder: "stroke",
                      stroke: "hsl(var(--background))",
                      strokeWidth: 3,
                      strokeLinejoin: "round",
                    }}
                  >
                    {m.value}
                  </text>
                )}
              </g>
            );
          }
          if (m.shape === "box") {
            // Box around the thin feature, with a minimum on-screen size + padding.
            const bp = boxPlacement(m, 6, 16);
            return (
              <g key={m.key} opacity={m.focused ? 1 : 0.7}>
                <rect
                  x={bp.x}
                  y={bp.y}
                  width={bp.w}
                  height={bp.h}
                  rx={3}
                  fill="none"
                  stroke={c}
                  strokeWidth={sw}
                  strokeDasharray={m.focused ? undefined : "3 2"}
                />
                {m.focused && (
                  <text
                    x={bp.labelX}
                    y={bp.labelY}
                    style={{
                      fill: c,
                      fontSize: "11px",
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                      paintOrder: "stroke",
                      stroke: "hsl(var(--background))",
                      strokeWidth: 3,
                      strokeLinejoin: "round",
                    }}
                  >
                    {m.value}
                  </text>
                )}
              </g>
            );
          }
          const { tx, ty } = dimTicks(m, tick);
          return (
            <g key={m.key} opacity={m.focused ? 1 : 0.7}>
              <line x1={m.ax} y1={m.ay} x2={m.bx} y2={m.by} stroke={c} strokeWidth={sw} />
              <line x1={m.ax + tx} y1={m.ay + ty} x2={m.ax - tx} y2={m.ay - ty} stroke={c} strokeWidth={sw} />
              <line x1={m.bx + tx} y1={m.by + ty} x2={m.bx - tx} y2={m.by - ty} stroke={c} strokeWidth={sw} />
              {m.focused && (
                <text
                  x={m.mx + 9}
                  y={m.my - 7}
                  style={{
                    fill: c,
                    fontSize: "11px",
                    fontWeight: 700,
                    fontVariantNumeric: "tabular-nums",
                    paintOrder: "stroke",
                    stroke: "hsl(var(--background))",
                    strokeWidth: 3,
                    strokeLinejoin: "round",
                  }}
                >
                  {m.value}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {/* Hover hitboxes (HTML) for the rich description cards. One covers the
          WHOLE marker (its a→b bounding box, padded, min 16px) — not just the
          midpoint — so a long box/line is hoverable along its full length even
          when its centre is off-screen. */}
      <TooltipPrimitive.Provider delayDuration={120}>
        {markers.filter((m) => m.shape !== "line").map((m) => {
          const { cx, cy, w, h } = hitboxPlacement(m, 8, 16);
          return (
          <TooltipPrimitive.Root key={m.key}>
            <TooltipPrimitive.Trigger asChild>
              <button
                type="button"
                tabIndex={-1}
                aria-label={m.label}
                className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2 rounded-sm"
                style={{ left: cx, top: cy, width: w, height: h }}
              />
            </TooltipPrimitive.Trigger>
            <TooltipPrimitive.Portal>
              <TooltipPrimitive.Content
                side="top"
                sideOffset={6}
                collisionPadding={8}
                className="z-50 max-w-[240px] rounded-md border border-border bg-popover px-2.5 py-1.5 text-[11px] leading-relaxed text-popover-foreground shadow-lg"
              >
                <div className="font-medium" style={{ color: SEVERITY[m.severity].hsl }}>
                  {m.label}
                </div>
                <div className="tabular-nums text-muted-foreground">
                  {m.value} · {t("limit")} {m.limit}
                </div>
                {m.detail && <div className="mt-0.5 text-muted-foreground">{m.detail}</div>}
                <TooltipPrimitive.Arrow className="fill-border" />
              </TooltipPrimitive.Content>
            </TooltipPrimitive.Portal>
          </TooltipPrimitive.Root>
          );
        })}
      </TooltipPrimitive.Provider>
    </div>
  );
});
