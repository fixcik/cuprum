import { useMemo } from "react";
import { packLayoutAvoiding, toolingHoleBounds, keepOutBox, type Box } from "@/lib/panelPlacement";
import type { NestSettings } from "@/lib/nest";
import type { KeepOutZone, ToolingHole } from "@/lib/api";

/** Live "on the panel" layout preview: the FR4 blank with the packed copies.
 *  `obstacles` are existing board instances (dimmed squares); `toolingHoles` are
 *  dimmed circles. Both are avoided when packing (holes folded into the obstacle
 *  list here so they render once as circles, not also as squares); new copies go
 *  in free cells. */
export function PanelLayoutPreview({
  boardWmm,
  boardHmm,
  panelWmm,
  panelHmm,
  nest,
  obstacles,
  clearanceMm,
  toolingHoles,
  keepOutZones,
}: {
  boardWmm: number;
  boardHmm: number;
  panelWmm: number;
  panelHmm: number;
  nest: NestSettings;
  obstacles?: Box[];
  clearanceMm?: number;
  toolingHoles?: ToolingHole[];
  keepOutZones?: KeepOutZone[];
}) {
  // Board boxes + tooling-hole bounds + keep-out zones form one obstacle list for the
  // packer; holes render separately as circles (above), so they aren't passed in as
  // squares. Zones are packer-only here (drawing them is out of scope).
  const packObstacles = useMemo(
    () => [
      ...(obstacles ?? []),
      ...(toolingHoles ?? []).map((h) => toolingHoleBounds({ xMm: h.x_mm, yMm: h.y_mm, diameterMm: h.diameter_mm })),
      ...(keepOutZones ?? []).map(keepOutBox),
    ],
    [obstacles, toolingHoles, keepOutZones],
  );
  const pack = useMemo(
    () => packLayoutAvoiding(boardWmm, boardHmm, panelWmm, panelHmm, nest, packObstacles, clearanceMm ?? 0),
    [boardWmm, boardHmm, panelWmm, panelHmm, nest, packObstacles, clearanceMm],
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
        {/* Tooling holes rendered as dimmed circles (WYSIWYG obstacles) */}
        {(toolingHoles ?? []).map((h) => {
          const r = (h.diameter_mm / 2) * scale;
          return (
            <div
              key={h.id}
              className="absolute rounded-full border border-muted-foreground/50 bg-muted-foreground/20"
              style={{
                left: h.x_mm * scale - r,
                top: h.y_mm * scale - r,
                width: r * 2,
                height: r * 2,
              }}
            />
          );
        })}
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
