import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useTranslation } from "react-i18next";
import type { Severity } from "@/lib/feasibility";

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

const SEV_COLOR: Record<Severity, string> = {
  block: "hsl(var(--destructive))",
  warn: "hsl(var(--warning))",
  info: "hsl(var(--muted-foreground))",
  ok: "hsl(var(--success))",
};

/** Colour for the "line" highlight — a vivid blue that stays legible over BOTH the
 *  white silk it overlays and the green board behind it, even zoomed out, without
 *  the alarm of red (grey washed out at distance). */
const LINE_HIGHLIGHT = "#3b82f6";

/** DRC dimension markers overlaid on the 2D preview: a coloured dimension line
 *  with end ticks at each issue, the value drawn on the focused one, and a hover
 *  card describing the problem. Screen-space; the parent projects mm→px. */
export function DrcMarkers({ markers, width, height }: { markers: ProjectedMarker[]; width: number; height: number }) {
  const { t } = useTranslation("common");
  if (markers.length === 0) return null;
  return (
    <div className="pointer-events-none absolute inset-0">
      <svg width={width} height={height} className="absolute inset-0">
        {[...markers]
          .sort((a, b) => (a.shape === "line" ? 0 : 1) - (b.shape === "line" ? 0 : 1))
          .map((m) => {
          const c = SEV_COLOR[m.severity];
          if (m.shape === "hover") {
            if (!m.focused) return null;
            // Focused cluster: a box (+ width label) so ‹› shows where it landed.
            const hpad = 6;
            const hx0 = Math.min(m.ax, m.bx) - hpad;
            const hy0 = Math.min(m.ay, m.by) - hpad;
            const hx1 = Math.max(m.ax, m.bx) + hpad;
            const hy1 = Math.max(m.ay, m.by) + hpad;
            const hbw = Math.max(hx1 - hx0, 16);
            const hbh = Math.max(hy1 - hy0, 16);
            const hcx = (hx0 + hx1) / 2;
            const hcy = (hy0 + hy1) / 2;
            const hcol = SEV_COLOR[m.severity];
            return (
              <g key={m.key}>
                <rect
                  x={hcx - hbw / 2}
                  y={hcy - hbh / 2}
                  width={hbw}
                  height={hbh}
                  rx={3}
                  fill="none"
                  stroke={hcol}
                  strokeWidth={2}
                />
                <text
                  x={hcx + hbw / 2 + 5}
                  y={hcy - hbh / 2}
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
          const len = Math.hypot(m.bx - m.ax, m.by - m.ay) || 1;
          // Perpendicular unit, for the end ticks.
          const px = -(m.by - m.ay) / len;
          const py = (m.bx - m.ax) / len;
          const tick = m.focused ? 7 : 4;
          const sw = m.focused ? 2 : 1.25;
          if (m.shape === "circle") {
            // Ring around a hole (a..b = its bbox). Drawn thick so it's visible,
            // solid on an error (or when focused), dashed otherwise.
            const cx = (m.ax + m.bx) / 2;
            const cy = (m.ay + m.by) / 2;
            const r = Math.max(Math.max(Math.abs(m.bx - m.ax), Math.abs(m.by - m.ay)) / 2, 8);
            const solid = m.focused || m.severity === "block";
            const cw = m.focused ? 2.75 : 2;
            return (
              <g key={m.key} opacity={m.focused ? 1 : 0.85}>
                <circle
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill="none"
                  stroke={c}
                  strokeWidth={cw}
                  strokeDasharray={solid ? undefined : "4 2"}
                />
                {m.focused && (
                  <text
                    x={cx + r + 5}
                    y={cy - r}
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
            const pad = 6;
            const x0 = Math.min(m.ax, m.bx) - pad;
            const y0 = Math.min(m.ay, m.by) - pad;
            const x1 = Math.max(m.ax, m.bx) + pad;
            const y1 = Math.max(m.ay, m.by) + pad;
            const cx = (x0 + x1) / 2;
            const cy = (y0 + y1) / 2;
            const bw = Math.max(x1 - x0, 16);
            const bh = Math.max(y1 - y0, 16);
            return (
              <g key={m.key} opacity={m.focused ? 1 : 0.7}>
                <rect
                  x={cx - bw / 2}
                  y={cy - bh / 2}
                  width={bw}
                  height={bh}
                  rx={3}
                  fill="none"
                  stroke={c}
                  strokeWidth={sw}
                  strokeDasharray={m.focused ? undefined : "3 2"}
                />
                {m.focused && (
                  <text
                    x={cx + bw / 2 + 5}
                    y={cy - bh / 2}
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
          return (
            <g key={m.key} opacity={m.focused ? 1 : 0.7}>
              <line x1={m.ax} y1={m.ay} x2={m.bx} y2={m.by} stroke={c} strokeWidth={sw} />
              <line x1={m.ax + px * tick} y1={m.ay + py * tick} x2={m.ax - px * tick} y2={m.ay - py * tick} stroke={c} strokeWidth={sw} />
              <line x1={m.bx + px * tick} y1={m.by + py * tick} x2={m.bx - px * tick} y2={m.by - py * tick} stroke={c} strokeWidth={sw} />
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
          const pad = 8;
          const x0 = Math.min(m.ax, m.bx);
          const y0 = Math.min(m.ay, m.by);
          const x1 = Math.max(m.ax, m.bx);
          const y1 = Math.max(m.ay, m.by);
          const cx = (x0 + x1) / 2;
          const cy = (y0 + y1) / 2;
          const w = Math.max(x1 - x0 + pad * 2, 16);
          const h = Math.max(y1 - y0 + pad * 2, 16);
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
                <div className="font-medium" style={{ color: SEV_COLOR[m.severity] }}>
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
}
