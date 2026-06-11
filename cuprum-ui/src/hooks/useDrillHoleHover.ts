import { useCallback, useEffect, useRef, useState } from "react";
import type Konva from "konva";
import type { Viewport } from "@/components/editor/RulersOverlay";
import type { PanelDrillPlan } from "@/lib/panelDrill";
import { nearestPlanHole } from "@/lib/drillHitTest";

export interface DrillHoleHover {
  /** Stable id of the hole under the cursor (drives the hover highlight ring). */
  hoveredHoleKey: string | null;
  /** Pointer position in screen CSS px (drives the rulers crosshair/readout). */
  hoverPx: { x: number; y: number } | null;
  /** Stage onMouseMove handler — coalesces hover work into one frame. */
  scheduleHover: () => void;
  /** Stage onMouseLeave handler — clears the hover state immediately. */
  clearHover: () => void;
}

/** Hover state machine for the drill map canvas, kept out of the Stage component.
 *
 *  Coalesces ALL hover work into one animation frame: regardless of how fast the
 *  mouse moves, the latest pointer is read once per frame and produces at most one
 *  hit-test and one paired state update (pointer px + hovered hole id). This keeps
 *  the cursor smooth on dense plans. The hit-test itself (nearestPlanHole) is the
 *  pure lib function; this hook owns only the rAF-coalesced state.
 *
 *  The caller still owns the Stage onClick (part of the single Stage integrator);
 *  this hook only wires the hover lifecycle handlers. */
export function useDrillHoleHover(args: {
  stageRef: React.RefObject<Konva.Stage>;
  fitGroupRef: React.RefObject<Konva.Group>;
  viewportRef: React.MutableRefObject<Viewport>;
  plan: PanelDrillPlan;
}): DrillHoleHover {
  const { stageRef, fitGroupRef, viewportRef, plan } = args;

  // Hover state: screen-px position (rulers crosshair/readout) + hovered hole key
  // (highlight ring). Both are driven by a SINGLE rAF coalescer below.
  const [hoveredHoleKey, setHoveredHoleKey] = useState<string | null>(null);
  const [hoverPx, setHoverPx] = useState<{ x: number; y: number } | null>(null);
  const hoverRaf = useRef<number | null>(null);

  // Coalesce ALL hover work into one frame: regardless of how fast the mouse
  // moves, we read the latest pointer once per frame and do at most one hit-test
  // and one paired state update. This keeps the cursor smooth on dense plans.
  const scheduleHover = useCallback(() => {
    if (hoverRaf.current != null) return;
    hoverRaf.current = requestAnimationFrame(() => {
      hoverRaf.current = null;
      const stage = stageRef.current;
      const pos = stage?.getPointerPosition() ?? null;
      setHoverPx(pos ? { x: pos.x, y: pos.y } : null);
      const fitGroup = fitGroupRef.current;
      const pxPerMm = viewportRef.current.pxPerMm;
      if (pos && fitGroup && pxPerMm > 0) {
        const rel = fitGroup.getRelativePointerPosition();
        const hit = rel ? nearestPlanHole({ x: rel.x, y: rel.y }, plan, pxPerMm) : null;
        setHoveredHoleKey(hit ? hit.id : null);
      } else {
        setHoveredHoleKey(null);
      }
    });
    // stageRef/fitGroupRef/viewportRef are stable refs; only `plan` matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  const clearHover = useCallback(() => {
    if (hoverRaf.current != null) {
      cancelAnimationFrame(hoverRaf.current);
      hoverRaf.current = null;
    }
    setHoverPx(null);
    setHoveredHoleKey(null);
  }, []);

  useEffect(() => () => { if (hoverRaf.current != null) cancelAnimationFrame(hoverRaf.current); }, []);

  return { hoveredHoleKey, hoverPx, scheduleHover, clearHover };
}
