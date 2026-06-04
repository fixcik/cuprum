import { useMemo } from "react";
import { packLayoutAvoiding, type Box } from "@/lib/panelPlacement";
import type { NestSettings } from "@/lib/nest";

/** Live "on the panel" layout preview: the FR4 blank with the packed copies.
 *  Existing instances are drawn dimmed underneath; new copies go in free cells. */
export function PanelLayoutPreview({
  boardWmm,
  boardHmm,
  panelWmm,
  panelHmm,
  nest,
  obstacles,
  clearanceMm,
}: {
  boardWmm: number;
  boardHmm: number;
  panelWmm: number;
  panelHmm: number;
  nest: NestSettings;
  obstacles?: Box[];
  clearanceMm?: number;
}) {
  const pack = useMemo(
    () => packLayoutAvoiding(boardWmm, boardHmm, panelWmm, panelHmm, nest, obstacles ?? [], clearanceMm ?? 0),
    [boardWmm, boardHmm, panelWmm, panelHmm, nest, obstacles, clearanceMm],
  );
  const VIEW_W = 520; // px width budget
  const VIEW_H = 420; // px height budget (pane minus p-6 padding)
  if (panelWmm <= 0 || panelHmm <= 0) return null;
  const scale = Math.min(VIEW_W / panelWmm, VIEW_H / panelHmm);
  const viewW = panelWmm * scale;
  const viewH = panelHmm * scale;
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div
        className="relative rounded-sm"
        style={{
          width: viewW,
          height: viewH,
          boxShadow: "inset 0 0 0 1.5px hsl(var(--primary)/.9)",
          backgroundColor: "hsl(var(--pcb-preview))",
          backgroundImage:
            "linear-gradient(hsl(var(--border)/.45) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border)/.45) 1px, transparent 1px)",
          backgroundSize: `${5 * scale}px ${5 * scale}px`,
        }}
      >
        {/* Existing placed instances (obstacles) rendered dimmed, below new copies */}
        {(obstacles ?? []).map((o, i) => (
          <div
            key={`obs-${i}`}
            className="absolute rounded-[1px] bg-muted-foreground/15 ring-1 ring-muted-foreground/40"
            style={{
              left: o.minX * scale,
              top: o.minY * scale,
              width: (o.maxX - o.minX) * scale,
              height: (o.maxY - o.minY) * scale,
            }}
          />
        ))}
        {/* New copies placed into free cells */}
        {pack.placements.map((p, i) => (
          <div
            key={i}
            className="absolute rounded-[1px] bg-primary/15 ring-1 ring-primary/70"
            style={{ left: p.x * scale, top: p.y * scale, width: pack.bw * scale, height: pack.bh * scale }}
          />
        ))}
      </div>
    </div>
  );
}
