import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MousePointerClick } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";

/** Soft-limit inset drawn inside the envelope frame (mm). */
const SOFT_PAD = 2;
/** Max trail points kept (machine-position breadcrumb). */
const TRAIL_MAX = 90;
/** Smoothing time constant (s) for easing the drawn position toward the latest
 *  reported one. GRBL status arrives in ~200ms steps, so we interpolate between
 *  reports to render a smooth marker instead of jumping. */
const SMOOTH_TAU = 0.08;
/** Below this distance (mm) the render position snaps to the target. */
const SETTLE_EPS = 0.01;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Pt {
  x: number;
  y: number;
}

interface FieldColors {
  field: string;
  primary: string;
  warning: string;
  axisZ: string;
}

/** 2D top-down view of the CNC work envelope (canvas). Draws the grid, soft
 *  limits, work zero, the tool's machine-position breadcrumb trail, and the live
 *  tool position. The drawn position is eased toward the latest reported one
 *  (rAF) so the marker glides instead of stepping with each status report.
 *  Hovering shows a crosshair + a HUD of the hovered WORK coords; clicking calls
 *  `onPick(workX, workY)` so the caller can move there.
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
  const { t } = useTranslation("machine");
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
  const E = {
    x: [0, env.x] as [number, number],
    y: [0, env.y] as [number, number],
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
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    if (W === 0 || H === 0) return;
    const bw = W * dpr;
    const bh = H * dpr;
    // Only resize when changed — assigning canvas.width/height clears the canvas
    // and reflows, which is wasteful on every animation frame.
    if (sizeRef.current.w !== bw || sizeRef.current.h !== bh) {
      can.width = bw;
      can.height = bh;
      can.style.width = `${W}px`;
      can.style.height = `${H}px`;
      sizeRef.current = { w: bw, h: bh };
    }
    const ctx = can.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const Eg = envRef.current;
    const ew = Eg.x[1] - Eg.x[0];
    const eh = Eg.y[1] - Eg.y[0];
    if (ew <= 0 || eh <= 0) return;
    const padL = 30;
    const padR = 16;
    const padT = 14;
    const padB = 22;
    const aw = W - padL - padR;
    const ah = H - padT - padB;
    const sc = Math.min(aw / ew, ah / eh);
    const ox = padL + (aw - ew * sc) / 2;
    const oy = padT + (ah - eh * sc) / 2;
    // machine mm → pixels (Y inverted: 0 at the bottom)
    const px = (x: number) => ox + (x - Eg.x[0]) * sc;
    const py = (y: number) => oy + (Eg.y[1] - y) * sc;

    // Resolve + cache themed colours from CSS custom properties (theme is static).
    if (!colorsRef.current) {
      const cs = getComputedStyle(can);
      const tok = (name: string, fallback: string) => {
        const v = cs.getPropertyValue(name).trim();
        return v ? `hsl(${v})` : fallback;
      };
      colorsRef.current = {
        field: tok("--field", "hsl(220 16% 8%)"),
        primary: tok("--primary", "hsl(24 80% 52%)"),
        warning: (() => {
          const v = cs.getPropertyValue("--warning").trim();
          return v ? `hsl(${v} / 0.5)` : "hsl(38 92% 55% / .5)";
        })(),
        axisZ: cs.getPropertyValue("--axis-z").trim() || "205 88% 58%",
      };
    }
    const colors = colorsRef.current;
    const axisZAlpha = (a: number) => `hsl(${colors.axisZ} / ${a})`;

    // work-zone background
    ctx.fillStyle = colors.field;
    ctx.fillRect(px(Eg.x[0]), py(Eg.y[1]), ew * sc, eh * sc);

    // grid 10mm / 50mm
    ctx.lineWidth = 1;
    for (let gx = Eg.x[0]; gx <= Eg.x[1] + 0.1; gx += 10) {
      const major = Math.round(gx) % 50 === 0;
      ctx.strokeStyle = major ? "hsl(222 12% 24%)" : "hsl(222 12% 17%)";
      ctx.beginPath();
      ctx.moveTo(px(gx), py(Eg.y[0]));
      ctx.lineTo(px(gx), py(Eg.y[1]));
      ctx.stroke();
    }
    for (let gy = Eg.y[0]; gy <= Eg.y[1] + 0.1; gy += 10) {
      const major = Math.round(gy) % 50 === 0;
      ctx.strokeStyle = major ? "hsl(222 12% 24%)" : "hsl(222 12% 17%)";
      ctx.beginPath();
      ctx.moveTo(px(Eg.x[0]), py(gy));
      ctx.lineTo(px(Eg.x[1]), py(gy));
      ctx.stroke();
    }

    // zone frame
    ctx.strokeStyle = "hsl(222 12% 30%)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px(Eg.x[0]), py(Eg.y[1]), ew * sc, eh * sc);

    // soft limits (dashed)
    ctx.strokeStyle = colors.warning;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(
      px(Eg.x[0] + SOFT_PAD),
      py(Eg.y[1] - SOFT_PAD),
      (ew - 2 * SOFT_PAD) * sc,
      (eh - 2 * SOFT_PAD) * sc,
    );
    ctx.setLineDash([]);

    // axis labels (every 50mm)
    ctx.fillStyle = "hsl(215 14% 50%)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = "center";
    for (let gx = Eg.x[0]; gx <= Eg.x[1]; gx += 50) ctx.fillText(String(gx), px(gx), py(Eg.y[0]) + 14);
    ctx.textAlign = "right";
    for (let gy = Eg.y[0]; gy <= Eg.y[1]; gy += 50) ctx.fillText(String(gy), px(Eg.x[0]) - 6, py(gy) + 3);

    // work zero (WCO) — cross + circle + label
    const wcoCur = wcoRef.current;
    const zx = px(wcoCur.x);
    const zy = py(wcoCur.y);
    ctx.strokeStyle = colors.primary;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(zx - 9, zy);
    ctx.lineTo(zx + 9, zy);
    ctx.moveTo(zx, zy - 9);
    ctx.lineTo(zx, zy + 9);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(zx, zy, 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = colors.primary;
    ctx.textAlign = "left";
    ctx.fillText("0,0", zx + 9, zy - 7);

    // breadcrumb trail (smoothed positions)
    const tr = trailRef.current;
    if (tr.length > 1) {
      ctx.lineWidth = 1.5;
      for (let i = 1; i < tr.length; i++) {
        ctx.strokeStyle = axisZAlpha(0.04 + 0.5 * (i / tr.length));
        ctx.beginPath();
        ctx.moveTo(px(tr[i - 1].x), py(tr[i - 1].y));
        ctx.lineTo(px(tr[i].x), py(tr[i].y));
        ctx.stroke();
      }
    }

    // hover crosshair
    const hov = hoverRef.current;
    if (hov && allowPickRef.current) {
      ctx.strokeStyle = "hsl(210 20% 92% / .25)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px(hov.x), py(Eg.y[0]));
      ctx.lineTo(px(hov.x), py(Eg.y[1]));
      ctx.moveTo(px(Eg.x[0]), py(hov.y));
      ctx.lineTo(px(Eg.x[1]), py(hov.y));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // current tool position (eased)
    const r = renderRef.current;
    const tx = px(r.x);
    const ty = py(r.y);
    ctx.strokeStyle = "hsl(210 20% 92% / .35)";
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    ctx.moveTo(tx, py(Eg.y[0]));
    ctx.lineTo(tx, py(Eg.y[1]));
    ctx.moveTo(px(Eg.x[0]), ty);
    ctx.lineTo(px(Eg.x[1]), ty);
    ctx.stroke();
    ctx.setLineDash([]);
    const st = stateRef.current;
    const moving = st === "jog" || st === "run" || st === "home";
    const alarm = st === "alarm";
    ctx.beginPath();
    ctx.arc(tx, ty, moving ? 7 : 6, 0, Math.PI * 2);
    ctx.fillStyle = alarm ? "hsl(0 70% 50% / .25)" : "hsl(24 80% 52% / .22)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = alarm ? "hsl(0 70% 55%)" : "hsl(24 85% 60%)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(tx, ty, 2, 0, Math.PI * 2);
    ctx.fillStyle = alarm ? "hsl(0 70% 60%)" : "hsl(24 90% 70%)";
    ctx.fill();
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
      const r = wrap.getBoundingClientRect();
      const W = r.width;
      const H = r.height;
      const ew = E.x[1] - E.x[0];
      const eh = E.y[1] - E.y[0];
      const padL = 30;
      const padR = 16;
      const padT = 14;
      const padB = 22;
      const aw = W - padL - padR;
      const ah = H - padT - padB;
      // Guard against a degenerate (zero) work envelope so a click never yields
      // NaN coordinates that would be sent to the machine.
      if (ew <= 0 || eh <= 0) return { x: E.x[0], y: E.y[0] };
      const sc = Math.min(aw / ew, ah / eh);
      const ox = padL + (aw - ew * sc) / 2;
      const oy = padT + (ah - eh * sc) / 2;
      const wmx = E.x[0] + (e.clientX - r.left - ox) / sc;
      const wmy = E.y[1] - (e.clientY - r.top - oy) / sc;
      return { x: clamp(wmx, E.x[0], E.x[1]), y: clamp(wmy, E.y[0], E.y[1]) };
    },
    [E.x, E.y],
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
      {hover && allowPick && (
        <div className="pointer-events-none absolute left-2 top-2 rounded-md border border-border bg-popover/90 px-2 py-1 font-mono text-[10px] tabular-nums text-muted-foreground backdrop-blur">
          → X{(hover.x - wco.x).toFixed(1)} Y{(hover.y - wco.y).toFixed(1)}
        </div>
      )}
      {allowPick && (
        <div className="pointer-events-none absolute bottom-2 right-2 flex items-center gap-1 rounded-md border border-border bg-popover/80 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur">
          <MousePointerClick className="size-3" /> {t("field.clickHint")}
        </div>
      )}
    </div>
  );
}
