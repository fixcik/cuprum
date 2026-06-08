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
  const W = big ? 520 : 300;
  const H = big ? 300 : 184;
  // Reserve bands around the bed so dimension labels never clip the viewBox: bottom
  // for the X label, left for the (rotated) Y label, right for the Z gauge. Without
  // the bottom reserve a wide bed (e.g. the UV screen) filled the full height and the
  // X label spilled past the SVG edge onto the dimension line.
  const pad = big ? 18 : 12;
  const dimBottom = big ? 32 : 26;
  const dimLeft = big ? 30 : 22;
  const gaugeReserve = screenOnly ? 0 : big ? 56 : 38;
  const left = pad + dimLeft;
  const top = pad;
  const innerW = W - left - pad - gaugeReserve;
  const innerH = H - top - pad - dimBottom;
  const ar = x > 0 && y > 0 ? x / y : 1;
  let rw = innerW;
  let rh = innerW / ar;
  if (rh > innerH) {
    rh = innerH;
    rw = innerH * ar;
  }
  const ox = left + (innerW - rw) / 2;
  const oy = top + (innerH - rh) / 2;
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

      {/* X dimension (bottom) — label sits centred ON the line, with a background
          rect sized to the text so the line is masked behind it (no overlap). */}
      <g>
        {(() => {
          const ly = oy + rh + (big ? 16 : 13);
          const fs = big ? 12 : 11;
          const label = `X ${dx} ${unit}`;
          const lw = label.length * fs * 0.6 + 8;
          return (
            <>
              <line x1={ox} y1={ly} x2={ox + rw} y2={ly} stroke={C("x")} strokeWidth="1" />
              <line x1={ox} y1={ly - 4} x2={ox} y2={ly + 4} stroke={C("x")} strokeWidth="1" />
              <line x1={ox + rw} y1={ly - 4} x2={ox + rw} y2={ly + 4} stroke={C("x")} strokeWidth="1" />
              <rect x={ox + rw / 2 - lw / 2} y={ly - fs / 2 - 2} width={lw} height={fs + 4} fill="hsl(var(--background))" />
              <text
                x={ox + rw / 2}
                y={ly + fs / 2 - 1}
                fontSize={fs}
                textAnchor="middle"
                fill={C("x")}
                className="tabular-nums"
              >
                {label}
              </text>
            </>
          );
        })()}
      </g>

      {/* Y dimension (left, rotated) — same masked-label treatment as X. */}
      <g>
        {(() => {
          const lx = ox - (big ? 16 : 14);
          const cy = oy + rh / 2;
          const fs = big ? 12 : 11;
          const label = `Y ${dy} ${unit}`;
          const lw = label.length * fs * 0.6 + 8;
          return (
            <>
              <line x1={lx} y1={oy} x2={lx} y2={oy + rh} stroke={C("y")} strokeWidth="1" />
              <line x1={lx - 4} y1={oy} x2={lx + 4} y2={oy} stroke={C("y")} strokeWidth="1" />
              <line x1={lx - 4} y1={oy + rh} x2={lx + 4} y2={oy + rh} stroke={C("y")} strokeWidth="1" />
              <g transform={`rotate(-90 ${lx} ${cy})`}>
                <rect x={lx - lw / 2} y={cy - fs / 2 - 2} width={lw} height={fs + 4} fill="hsl(var(--background))" />
                <text
                  x={lx}
                  y={cy + fs / 2 - 1}
                  fontSize={fs}
                  textAnchor="middle"
                  fill={C("y")}
                  className="tabular-nums"
                >
                  {label}
                </text>
              </g>
            </>
          );
        })()}
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
              Z {dz} {unit}
            </text>
          </g>
        </>
      )}
    </svg>
  );
}
