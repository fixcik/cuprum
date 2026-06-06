import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MousePointerClick } from "lucide-react";
import { useMachine } from "@/machineStore";
import { useSettings } from "@/settingsStore";

/** Soft-limit inset drawn inside the envelope frame (mm). */
const SOFT_PAD = 2;
/** Max trail points kept (machine-position breadcrumb). */
const TRAIL_MAX = 90;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

interface Pt {
  x: number;
  y: number;
}

/** 2D top-down view of the CNC work envelope (canvas). Draws the grid, soft
 *  limits, work zero, the tool's machine-position breadcrumb trail, and the live
 *  tool position. Hovering shows a crosshair + a HUD of the hovered WORK coords;
 *  clicking calls `onPick(workX, workY)` so the caller can move there.
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

  // Accumulate the machine-position trail (only when it moves enough).
  useEffect(() => {
    const tr = trailRef.current;
    const last = tr[tr.length - 1];
    if (!last || Math.hypot(last.x - mx, last.y - my) > 0.4) {
      tr.push({ x: mx, y: my });
      if (tr.length > TRAIL_MAX) tr.shift();
    }
  }, [mx, my]);

  useEffect(() => {
    const can = canRef.current;
    const wrap = wrapRef.current;
    if (!can || !wrap) return;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      if (W === 0 || H === 0) return;
      can.width = W * dpr;
      can.height = H * dpr;
      can.style.width = `${W}px`;
      can.style.height = `${H}px`;
      const ctx = can.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const ew = E.x[1] - E.x[0];
      const eh = E.y[1] - E.y[0];
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
      const px = (x: number) => ox + (x - E.x[0]) * sc;
      const py = (y: number) => oy + (E.y[1] - y) * sc;

      // Resolve themed colours from CSS custom properties.
      const cs = getComputedStyle(can);
      const tok = (name: string, fallback: string) => {
        const v = cs.getPropertyValue(name).trim();
        return v ? `hsl(${v})` : fallback;
      };
      const tokA = (name: string, alpha: number, fallback: string) => {
        const v = cs.getPropertyValue(name).trim();
        return v ? `hsl(${v} / ${alpha})` : fallback;
      };
      const colField = tok("--field", "hsl(220 16% 8%)");
      const colPrimary = tok("--primary", "hsl(24 80% 52%)");
      const colWarning = tokA("--warning", 0.5, "hsl(38 92% 55% / .5)");
      const colAxisZ = "--axis-z";

      // work-zone background
      ctx.fillStyle = colField;
      ctx.fillRect(px(E.x[0]), py(E.y[1]), ew * sc, eh * sc);

      // grid 10mm / 50mm
      ctx.lineWidth = 1;
      for (let gx = E.x[0]; gx <= E.x[1] + 0.1; gx += 10) {
        const major = Math.round(gx) % 50 === 0;
        ctx.strokeStyle = major ? "hsl(222 12% 24%)" : "hsl(222 12% 17%)";
        ctx.beginPath();
        ctx.moveTo(px(gx), py(E.y[0]));
        ctx.lineTo(px(gx), py(E.y[1]));
        ctx.stroke();
      }
      for (let gy = E.y[0]; gy <= E.y[1] + 0.1; gy += 10) {
        const major = Math.round(gy) % 50 === 0;
        ctx.strokeStyle = major ? "hsl(222 12% 24%)" : "hsl(222 12% 17%)";
        ctx.beginPath();
        ctx.moveTo(px(E.x[0]), py(gy));
        ctx.lineTo(px(E.x[1]), py(gy));
        ctx.stroke();
      }

      // zone frame
      ctx.strokeStyle = "hsl(222 12% 30%)";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(px(E.x[0]), py(E.y[1]), ew * sc, eh * sc);

      // soft limits (dashed)
      ctx.strokeStyle = colWarning;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(
        px(E.x[0] + SOFT_PAD),
        py(E.y[1] - SOFT_PAD),
        (ew - 2 * SOFT_PAD) * sc,
        (eh - 2 * SOFT_PAD) * sc,
      );
      ctx.setLineDash([]);

      // axis labels (every 50mm)
      ctx.fillStyle = "hsl(215 14% 50%)";
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "center";
      for (let gx = E.x[0]; gx <= E.x[1]; gx += 50) ctx.fillText(String(gx), px(gx), py(E.y[0]) + 14);
      ctx.textAlign = "right";
      for (let gy = E.y[0]; gy <= E.y[1]; gy += 50) ctx.fillText(String(gy), px(E.x[0]) - 6, py(gy) + 3);

      // work zero (WCO) — cross + circle + label
      const zx = px(wco.x);
      const zy = py(wco.y);
      ctx.strokeStyle = colPrimary;
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
      ctx.fillStyle = colPrimary;
      ctx.textAlign = "left";
      ctx.fillText("0,0", zx + 9, zy - 7);

      // breadcrumb trail
      const tr = trailRef.current;
      if (tr.length > 1) {
        ctx.lineWidth = 1.5;
        for (let i = 1; i < tr.length; i++) {
          ctx.strokeStyle = tokA(
            colAxisZ,
            0.04 + 0.5 * (i / tr.length),
            `hsl(205 88% 58% / ${0.04 + 0.5 * (i / tr.length)})`,
          );
          ctx.beginPath();
          ctx.moveTo(px(tr[i - 1].x), py(tr[i - 1].y));
          ctx.lineTo(px(tr[i].x), py(tr[i].y));
          ctx.stroke();
        }
      }

      // hover crosshair
      if (hover && allowPick) {
        ctx.strokeStyle = "hsl(210 20% 92% / .25)";
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(px(hover.x), py(E.y[0]));
        ctx.lineTo(px(hover.x), py(E.y[1]));
        ctx.moveTo(px(E.x[0]), py(hover.y));
        ctx.lineTo(px(E.x[1]), py(hover.y));
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // current tool position
      const tx = px(mx);
      const ty = py(my);
      ctx.strokeStyle = "hsl(210 20% 92% / .35)";
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(tx, py(E.y[0]));
      ctx.lineTo(tx, py(E.y[1]));
      ctx.moveTo(px(E.x[0]), ty);
      ctx.lineTo(px(E.x[1]), ty);
      ctx.stroke();
      ctx.setLineDash([]);
      const moving = state === "jog" || state === "run" || state === "home";
      const alarm = state === "alarm";
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
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(wrap);
    return () => ro.disconnect();
    // E is rebuilt from env each render; depend on its scalar bounds.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mx, my, wco.x, wco.y, state, hover, allowPick, env.x, env.y]);

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
      <canvas
        ref={canRef}
        onMouseMove={(e) => allowPick && setHover(toWorld(e))}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          if (!allowPick) return;
          const w = toWorld(e);
          onPick?.(w.x - wco.x, w.y - wco.y);
        }}
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
