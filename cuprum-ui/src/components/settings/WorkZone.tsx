import { useId } from "react";
import { useUnitFormat } from "@/i18n/useUnitFormat";

/** Top-down X×Y bed drawn to scale, plus a side Z gauge. Echoes the "Рабочее
 *  поле" panel on the control tab. Pure presentational SVG — input values are mm;
 *  dimension labels are formatted via useUnitFormat (so they respect the units
 *  setting — never a hardcoded unit string).
 *
 *  `activeAxis` highlights one axis (its dim label / the bed border / Z fill turn
 *  orange) while the operator edits that field. `screenOnly` drops the Z gauge and
 *  spindle dot for the UV screen card (just the rectangle + X/Y dims). */
export type WorkZoneAxis = "x" | "y" | "z";

export function WorkZone({
  x,
  y,
  z,
  activeAxis,
  big,
  screenOnly,
}: {
  x: number;
  y: number;
  z: number;
  activeAxis?: WorkZoneAxis;
  big?: boolean;
  screenOnly?: boolean;
}) {
  const { toDisplay, unitLabel } = useUnitFormat();
  const unit = unitLabel("coarse");
  const dx = toDisplay(x, "coarse");
  const dy = toDisplay(y, "coarse");
  const dz = toDisplay(z, "coarse");
  // Unique pattern id per instance — a document-global id collides when two
  // WorkZones mount (CNC + UV, or quick machine switches). Strip colons (invalid
  // in some selectors) from React's generated id.
  const gridId = `wzgrid-${useId().replace(/:/g, "")}`;
  const pad = big ? 46 : 30;
  const W = big ? 520 : 300;
  const H = big ? 300 : 184;
  // Leave room on the right for the Z gauge (unless screen-only).
  const gaugeReserve = screenOnly ? 0 : big ? 60 : 38;
  const innerW = W - pad * 2 - gaugeReserve;
  const innerH = H - pad * 2;
  const ar = x > 0 && y > 0 ? x / y : 1;
  let rw = innerW;
  let rh = innerW / ar;
  if (rh > innerH) {
    rh = innerH;
    rw = innerH * ar;
  }
  const ox = pad + (innerW - rw) / 2;
  const oy = pad + (innerH - rh) / 2;
  const grid = big ? 26 : 18;

  // Axis colour: orange when active, muted otherwise.
  const C = (a: WorkZoneAxis) =>
    activeAxis === a ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))";

  const gaugeX = W - (big ? 40 : 26);
  const gaugeTop = oy;
  const gaugeBot = oy + rh;
  const zFrac = Math.max(0.08, Math.min(1, z / 200));
  const zFill = gaugeBot - (gaugeBot - gaugeTop) * zFrac;
  const bedActive = activeAxis === "x" || activeAxis === "y";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="block select-none">
      <defs>
        <pattern id={gridId} width={grid} height={grid} patternUnits="userSpaceOnUse">
          <path
            d={`M ${grid} 0 L 0 0 0 ${grid}`}
            fill="none"
            stroke="hsl(var(--border))"
            strokeOpacity="0.5"
            strokeWidth="1"
          />
        </pattern>
      </defs>

      {/* bed */}
      <rect x={ox} y={oy} width={rw} height={rh} rx="2" fill="hsl(213 14% 9%)" />
      <rect x={ox} y={oy} width={rw} height={rh} rx="2" fill={`url(#${gridId})`} />
      <rect
        x={ox}
        y={oy}
        width={rw}
        height={rh}
        rx="2"
        fill="none"
        stroke="hsl(var(--primary))"
        strokeOpacity={bedActive ? 0.9 : 0.55}
        strokeWidth="1.5"
        strokeDasharray="5 4"
      />

      {/* origin marker bottom-left (0,0) */}
      <g transform={`translate(${ox} ${oy + rh})`}>
        <circle r="5" fill="none" stroke="hsl(var(--primary))" strokeWidth="1.5" />
        <line x1="-8" y1="0" x2="8" y2="0" stroke="hsl(var(--primary))" strokeWidth="1.5" />
        <line x1="0" y1="-8" x2="0" y2="8" stroke="hsl(var(--primary))" strokeWidth="1.5" />
        <text x="9" y="-7" fontSize={big ? 12 : 10} fill="hsl(var(--primary))" className="tabular-nums">
          0,0
        </text>
      </g>

      {/* X dimension (bottom) */}
      <g>
        <line x1={ox} y1={oy + rh + 14} x2={ox + rw} y2={oy + rh + 14} stroke={C("x")} strokeWidth="1" />
        <line x1={ox} y1={oy + rh + 10} x2={ox} y2={oy + rh + 18} stroke={C("x")} strokeWidth="1" />
        <line x1={ox + rw} y1={oy + rh + 10} x2={ox + rw} y2={oy + rh + 18} stroke={C("x")} strokeWidth="1" />
        <rect x={ox + rw / 2 - 32} y={oy + rh + 19} width="64" height="16" rx="3" fill="hsl(var(--background))" />
        <text
          x={ox + rw / 2}
          y={oy + rh + 31}
          fontSize={big ? 12 : 11}
          textAnchor="middle"
          fill={C("x")}
          className="tabular-nums"
        >
          X {dx} {unit}
        </text>
      </g>

      {/* Y dimension (left, rotated) */}
      <g>
        <line x1={ox - 14} y1={oy} x2={ox - 14} y2={oy + rh} stroke={C("y")} strokeWidth="1" />
        <line x1={ox - 18} y1={oy} x2={ox - 10} y2={oy} stroke={C("y")} strokeWidth="1" />
        <line x1={ox - 18} y1={oy + rh} x2={ox - 10} y2={oy + rh} stroke={C("y")} strokeWidth="1" />
        <text
          x={ox - 18}
          y={oy + rh / 2}
          fontSize={big ? 12 : 11}
          textAnchor="middle"
          fill={C("y")}
          className="tabular-nums"
          transform={`rotate(-90 ${ox - 18} ${oy + rh / 2})`}
        >
          Y {dy} {unit}
        </text>
      </g>

      {!screenOnly && (
        <>
          {/* spindle pos dot */}
          <circle cx={ox + rw * 0.62} cy={oy + rh * 0.38} r={big ? 5 : 4} fill="hsl(var(--primary))" />
          <circle
            cx={ox + rw * 0.62}
            cy={oy + rh * 0.38}
            r={big ? 10 : 8}
            fill="none"
            stroke="hsl(var(--primary))"
            strokeOpacity="0.4"
          />

          {/* Z gauge */}
          <g>
            <rect
              x={gaugeX}
              y={gaugeTop}
              width={big ? 16 : 12}
              height={rh}
              rx="3"
              fill="hsl(213 14% 9%)"
              stroke="hsl(var(--border))"
            />
            <rect
              x={gaugeX}
              y={zFill}
              width={big ? 16 : 12}
              height={gaugeBot - zFill}
              rx="3"
              fill={activeAxis === "z" ? "hsl(var(--primary))" : "hsl(207 80% 56%)"}
              fillOpacity="0.75"
            />
            <text
              x={gaugeX + (big ? 8 : 6)}
              y={gaugeTop - 6}
              fontSize={big ? 12 : 10}
              textAnchor="middle"
              fill={C("z")}
              className="tabular-nums"
            >
              Z {dz}
            </text>
          </g>
        </>
      )}
    </svg>
  );
}
