import { useCallback, useEffect, useRef, useState } from "react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";
import {
  drawWorkField,
  projectPointerToWorld,
  resolveFieldColors,
  type Envelope,
  type FieldColors,
  type Pt,
} from "@/components/machine/workFieldDraw";
import { WorkFieldHud } from "@/components/machine/WorkFieldHud";

/** Max trail points kept (machine-position breadcrumb). */
const TRAIL_MAX = 90;
/** Smoothing time constant (s) for easing the drawn position toward the latest
 *  reported one. GRBL status arrives in ~200ms steps, so we interpolate between
 *  reports to render a smooth marker instead of jumping. */
const SMOOTH_TAU = 0.08;
/** Below this distance (mm) the render position snaps to the target. */
const SETTLE_EPS = 0.01;

/** 2D top-down view of the CNC work envelope (canvas). Draws the grid, soft
 *  limits, work zero, the tool's machine-position breadcrumb trail, and the live
 *  tool position. The drawn position is eased toward the latest reported one
 *  (rAF) so the marker glides instead of stepping with each status report.
 *  Hovering shows a crosshair + a HUD of the hovered WORK coords; clicking calls
 *  `onPick(workX, workY)` so the caller can move there.
 *
 *  The painting itself lives in `workFieldDraw.ts` (pure canvas routine) and the
 *  overlays in `WorkFieldHud`; this component owns the refs, the rAF easing loop
 *  and the single mouse integrator (hover / click → pick), which stays whole.
 *
 *  When `disabled` (not connected / not movable) the cursor and click are inert. */
export function WorkField({
  onPick,
  disabled = false,
  className,
}: {
  onPick?: (workX: number, workY: number) => void;
  disabled?: boolean;
  className?: string;
}) {
  const canRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const trailRef = useRef<Pt[]>([]);
  const [hover, setHover] = useState<Pt | null>(null);

  const env = useSettings((s) => s.cncProfile.workEnvelopeMm);
  const status = useMachine((s) => s.status);
  const [mx, my] = status.mpos;
  const [wx, wy] = status.wpos;
  const state = status.state;
  // Work-coordinate offset: machine = work + wco  →  wco = machine − work.
  const wco: Pt = { x: mx - wx, y: my - wy };

  // Envelope ranges (mm), Y up. X/Y start at the machine origin.
  const E: Envelope = {
    x: [0, env.x],
    y: [0, env.y],
  };

  const allowPick = !disabled && !!onPick;

  // --- refs read by the rAF draw loop (avoid stale closures) ---
  const targetRef = useRef<Pt>({ x: mx, y: my }); // latest reported machine pos
  const renderRef = useRef<Pt>({ x: mx, y: my }); // eased, drawn position
  const wcoRef = useRef(wco);
  const stateRef = useRef(state);
  const envRef = useRef(E);
  const hoverRef = useRef(hover);
  const allowPickRef = useRef(allowPick);
  const colorsRef = useRef<FieldColors | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef(0);
  // Last backing-store size, so we only resize the canvas (which clears it and
  // forces a reflow) when the box actually changed — not on every rAF frame.
  const sizeRef = useRef({ w: 0, h: 0 });
  wcoRef.current = wco;
  stateRef.current = state;
  envRef.current = E;
  hoverRef.current = hover;
  allowPickRef.current = allowPick;

  const draw = useCallback(() => {
    const can = canRef.current;
    const wrap = wrapRef.current;
    if (!can || !wrap) return;
    // Resolve + cache themed colours from CSS custom properties (theme is static).
    if (!colorsRef.current) colorsRef.current = resolveFieldColors(can);
    drawWorkField({
      can,
      wrap,
      env: envRef.current,
      wco: wcoRef.current,
      state: stateRef.current,
      hover: hoverRef.current,
      allowPick: allowPickRef.current,
      render: renderRef.current,
      trail: trailRef.current,
      colors: colorsRef.current,
      size: sizeRef.current,
    });
  }, []);

  // rAF loop: ease the render position toward the target, redraw, and keep
  // running while still settling or while hovering (so the crosshair tracks).
  const loop = useCallback(
    (now: number) => {
      const last = lastTsRef.current || now;
      const dt = Math.min(0.05, (now - last) / 1000);
      lastTsRef.current = now;

      const tg = targetRef.current;
      const r = renderRef.current;
      const k = 1 - Math.exp(-dt / SMOOTH_TAU);
      let nx = r.x + (tg.x - r.x) * k;
      let ny = r.y + (tg.y - r.y) * k;
      const dist = Math.hypot(tg.x - nx, tg.y - ny);
      const settled = dist < SETTLE_EPS;
      if (settled) {
        nx = tg.x;
        ny = tg.y;
      }
      renderRef.current = { x: nx, y: ny };

      // breadcrumb from the smoothed position
      const tr = trailRef.current;
      const lastP = tr[tr.length - 1];
      if (!lastP || Math.hypot(lastP.x - nx, lastP.y - ny) > 0.4) {
        tr.push({ x: nx, y: ny });
        if (tr.length > TRAIL_MAX) tr.shift();
      }

      draw();

      if (!settled || hoverRef.current) {
        rafRef.current = requestAnimationFrame(loop);
      } else {
        rafRef.current = null;
      }
    },
    [draw],
  );

  const schedule = useCallback(() => {
    if (rafRef.current == null) {
      lastTsRef.current = 0;
      rafRef.current = requestAnimationFrame(loop);
    }
  }, [loop]);

  // New reported position → new easing target; wake the loop.
  useEffect(() => {
    targetRef.current = { x: mx, y: my };
    schedule();
  }, [mx, my, schedule]);

  // Redraw when anything else visible changes (work zero / state / envelope /
  // hover / pick-ability). The loop draws once and stops if already settled.
  useEffect(() => {
    schedule();
  }, [wco.x, wco.y, state, env.x, env.y, hover, allowPick, schedule]);

  // Redraw on resize.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => schedule());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [schedule]);

  // Stop the loop on unmount.
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    },
    [],
  );

  const toWorld = useCallback(
    (e: React.MouseEvent): Pt => {
      const wrap = wrapRef.current;
      if (!wrap) return { x: 0, y: 0 };
      return projectPointerToWorld(e, wrap, E);
    },
    [E],
  );

  return (
    <div
      ref={wrapRef}
      className={`relative h-full w-full overflow-hidden rounded-lg border border-border ${className ?? ""}`}
    >
      {/* Absolutely positioned so the canvas's explicit pixel size (set from the
       *  wrap's clientWidth in draw()) never feeds back into layout: an in-flow
       *  canvas would force its flex ancestors at least as wide as its last drawn
       *  width, so shrinking the window could never shrink the field (it pushed
       *  the whole panel past the viewport). Out of flow, the wrap is sized purely
       *  by flex and the canvas just fills it. */}
      <canvas
        ref={canRef}
        onMouseMove={(e) => allowPick && setHover(toWorld(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          if (!allowPick) return;
          const w = toWorld(e);
          onPick?.(w.x - wco.x, w.y - wco.y);
        }}
        className="absolute inset-0"
        style={{ cursor: allowPick ? "crosshair" : "default", display: "block" }}
      />
      <WorkFieldHud
        hover={hover ? { x: hover.x - wco.x, y: hover.y - wco.y } : null}
        allowPick={allowPick}
      />
    </div>
  );
}
