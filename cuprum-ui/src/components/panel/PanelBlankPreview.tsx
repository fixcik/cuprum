import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

/** 2D preview of an empty FR4 blank — a green rectangle with a 10 mm grid,
 *  dimension labels, a top/bottom mirror toggle, and simple zoom. No layers
 *  yet (board instances arrive in Phase 2). */
export function PanelBlankPreview({ widthMm, heightMm }: { widthMm: number; heightMm: number }) {
  const { t } = useTranslation("project");
  const [side, setSide] = useState<"top" | "bottom">("top");
  const [zoom, setZoom] = useState(1);

  const margin = Math.max(widthMm, heightMm) * 0.12 + 6;
  const vbW = widthMm + margin * 2;
  const vbH = heightMm + margin * 2;
  const labelSize = Math.max(2.5, vbW * 0.022);

  const gridStep = 10;
  const vlines: number[] = [];
  for (let x = gridStep; x < widthMm; x += gridStep) vlines.push(x);
  const hlines: number[] = [];
  for (let y = gridStep; y < heightMm; y += gridStep) hlines.push(y);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <SegmentedControl<"top" | "bottom">
          options={[
            { value: "top", label: t("setup.sideTop") },
            { value: "bottom", label: t("setup.sideBottom") },
          ]}
          value={side}
          onChange={setSide}
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.25, Math.round((z - 0.25) * 100) / 100))}
            className="rounded px-2 py-1 text-[13px] text-muted-foreground hover:text-foreground"
          >
            −
          </button>
          <span className="w-10 text-center text-[11px] tabular-nums text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(4, Math.round((z + 0.25) * 100) / 100))}
            className="rounded px-2 py-1 text-[13px] text-muted-foreground hover:text-foreground"
          >
            +
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-background p-4">
        <svg
          viewBox={`0 0 ${vbW} ${vbH}`}
          className="max-h-full max-w-full"
          style={{ transform: `scale(${zoom})` }}
          preserveAspectRatio="xMidYMid meet"
        >
          <g
            transform={`translate(${margin} ${margin}) ${
              side === "bottom" ? `translate(${widthMm} 0) scale(-1 1)` : ""
            }`}
          >
            <rect x={0} y={0} width={widthMm} height={heightMm} rx={1} fill="#1f6b4a" stroke="#0c3a28" strokeWidth={0.4} />
            {vlines.map((x) => (
              <line key={`v${x}`} x1={x} y1={0} x2={x} y2={heightMm} stroke="#ffffff" strokeOpacity={0.08} strokeWidth={0.15} />
            ))}
            {hlines.map((y) => (
              <line key={`h${y}`} x1={0} y1={y} x2={widthMm} y2={y} stroke="#ffffff" strokeOpacity={0.08} strokeWidth={0.15} />
            ))}
          </g>
          <text x={margin + widthMm / 2} y={margin * 0.6} textAnchor="middle" fontSize={labelSize} className="fill-muted-foreground">
            {widthMm} mm
          </text>
          <text
            x={margin * 0.6}
            y={margin + heightMm / 2}
            textAnchor="middle"
            fontSize={labelSize}
            transform={`rotate(-90 ${margin * 0.6} ${margin + heightMm / 2})`}
            className="fill-muted-foreground"
          >
            {heightMm} mm
          </text>
        </svg>
      </div>
    </div>
  );
}
