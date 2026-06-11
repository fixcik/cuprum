import { useCallback, useEffect, useRef, useState } from "react";

/** A hover-crosshair position (screen CSS px) plus whether it snapped onto a real
 *  blank/instance feature (→ a lock ring) vs a free/grid point. */
export type HoverPx = { x: number; y: number; snapped: boolean };

/** Hover crosshair + readout state for the panel canvas. The overlay is opt-in
 *  (off by default — it's busy and most placement is done by eye/snap) and Esc
 *  turns it off (mirrors the design preview's Esc behaviour).
 *
 *  Hover updates are coalesced to one per animation frame: a bare mousemove
 *  handler would re-render the whole instance tree on every pixel of movement.
 *  The latest pointer lives in a ref; the frame flushes whatever is freshest. */
export function useCrosshairState() {
  // `snapped` marks the crosshair locked onto a blank/instance corner/edge/centre
  // (→ a lock ring); false for a free point (Alt held) or a plain grid node.
  const [hoverPx, setHoverPx] = useState<HoverPx | null>(null);
  // The hover crosshair + readout is opt-in (off by default — it's busy and most
  // placement is done by eye/snap).
  const [showCrosshair, setShowCrosshair] = useState(false);
  // Coalesce hover updates to one per animation frame: a bare mousemove handler
  // would re-render the whole instance tree on every pixel of movement. The latest
  // pointer lives in a ref; the frame flushes whatever is freshest.
  const hoverRaf = useRef<number | null>(null);
  const pendingHover = useRef<HoverPx | null>(null);
  const queueHover = useCallback((p: HoverPx | null) => {
    pendingHover.current = p;
    if (p === null) {
      if (hoverRaf.current != null) {
        cancelAnimationFrame(hoverRaf.current);
        hoverRaf.current = null;
      }
      setHoverPx(null);
      return;
    }
    if (hoverRaf.current != null) return;
    hoverRaf.current = requestAnimationFrame(() => {
      hoverRaf.current = null;
      setHoverPx(pendingHover.current);
    });
  }, []);
  useEffect(() => () => { if (hoverRaf.current != null) cancelAnimationFrame(hoverRaf.current); }, []);

  // Esc turns the hover crosshair off (mirrors the design preview's Esc behaviour).
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => { if (e.key === "Escape") setShowCrosshair(false); };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, []);

  return { hoverPx, showCrosshair, setShowCrosshair, queueHover };
}
