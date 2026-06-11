/** Pure presentational drawing/geometry for {@link WorkField}.
 *
 *  These helpers hold no state and no React: the parent owns the refs, the rAF
 *  easing loop and the mouse integrator, and calls into here purely to (a) map a
 *  pointer event to WORK-envelope coordinates and (b) paint the canvas frame.
 *  Keeping them stateless and outside the component lets the visualisation be
 *  reasoned about (and the integrator stay whole, per the single-dispatch rule). */

/** Soft-limit inset drawn inside the envelope frame (mm). */
export const SOFT_PAD = 2;

export interface Pt {
  x: number;
  y: number;
}

export interface FieldColors {
  field: string;
  primary: string;
  warning: string;
  axisZ: string;
}

/** Envelope ranges (mm), Y up. X/Y start at the machine origin. */
export interface Envelope {
  x: [number, number];
  y: [number, number];
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Inner-plot padding (px) carved out of the canvas box for axis labels. Shared
 *  by the draw routine and the pointer→world projection so a click lands exactly
 *  where the marker is drawn. */
const PAD = { l: 30, r: 16, t: 14, b: 22 } as const;

/** Resolve + cache themed colours from CSS custom properties (theme is static).
 *  Reads from the given canvas's computed style. */
export function resolveFieldColors(can: HTMLCanvasElement): FieldColors {
  const cs = getComputedStyle(can);
  const tok = (name: string, fallback: string) => {
    const v = cs.getPropertyValue(name).trim();
    return v ? `hsl(${v})` : fallback;
  };
  return {
    field: tok("--field", "hsl(220 16% 8%)"),
    primary: tok("--primary", "hsl(24 80% 52%)"),
    warning: (() => {
      const v = cs.getPropertyValue("--warning").trim();
      return v ? `hsl(${v} / 0.5)` : "hsl(38 92% 55% / .5)";
    })(),
    axisZ: cs.getPropertyValue("--axis-z").trim() || "205 88% 58%",
  };
}

/** Map a mouse event over `wrap` to clamped WORK-envelope coordinates (mm, Y up).
 *  Returns the envelope origin for a degenerate (zero) envelope so a click never
 *  yields NaN coordinates that would be sent to the machine. */
export function projectPointerToWorld(e: React.MouseEvent, wrap: HTMLDivElement, E: Envelope): Pt {
  const r = wrap.getBoundingClientRect();
  const W = r.width;
  const H = r.height;
  const ew = E.x[1] - E.x[0];
  const eh = E.y[1] - E.y[0];
  const aw = W - PAD.l - PAD.r;
  const ah = H - PAD.t - PAD.b;
  if (ew <= 0 || eh <= 0) return { x: E.x[0], y: E.y[0] };
  const sc = Math.min(aw / ew, ah / eh);
  const ox = PAD.l + (aw - ew * sc) / 2;
  const oy = PAD.t + (ah - eh * sc) / 2;
  const wmx = E.x[0] + (e.clientX - r.left - ox) / sc;
  const wmy = E.y[1] - (e.clientY - r.top - oy) / sc;
  return { x: clamp(wmx, E.x[0], E.x[1]), y: clamp(wmy, E.y[0], E.y[1]) };
}

export interface DrawArgs {
  can: HTMLCanvasElement;
  wrap: HTMLDivElement;
  env: Envelope;
  /** Work-coordinate offset (machine = work + wco). Drawn as the 0,0 datum. */
  wco: Pt;
  /** Machine state, drives the marker colour / size. */
  state: string;
  /** Hovered WORK coords (crosshair), or null. */
  hover: Pt | null;
  /** Whether picking is allowed — gates the hover crosshair. */
  allowPick: boolean;
  /** Eased, drawn machine position. */
  render: Pt;
  /** Smoothed machine-position breadcrumb. */
  trail: Pt[];
  /** Cached themed colours (resolved once via {@link resolveFieldColors}). */
  colors: FieldColors;
  /** Last backing-store size, mutated in place so the canvas is only resized
   *  (which clears + reflows) when the box actually changed. */
  size: { w: number; h: number };
}

/** Paint one frame of the work-envelope view onto `can`. Pure given its args —
 *  all easing/state lives in the caller. */
export function drawWorkField(args: DrawArgs): void {
  const { can, wrap, env: Eg, wco, state, hover, allowPick, render, trail, colors, size } = args;
  const dpr = window.devicePixelRatio || 1;
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if (W === 0 || H === 0) return;
  const bw = W * dpr;
  const bh = H * dpr;
  // Only resize when changed — assigning canvas.width/height clears the canvas
  // and reflows, which is wasteful on every animation frame.
  if (size.w !== bw || size.h !== bh) {
    can.width = bw;
    can.height = bh;
    can.style.width = `${W}px`;
    can.style.height = `${H}px`;
    size.w = bw;
    size.h = bh;
  }
  const ctx = can.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const ew = Eg.x[1] - Eg.x[0];
  const eh = Eg.y[1] - Eg.y[0];
  if (ew <= 0 || eh <= 0) return;
  const aw = W - PAD.l - PAD.r;
  const ah = H - PAD.t - PAD.b;
  const sc = Math.min(aw / ew, ah / eh);
  const ox = PAD.l + (aw - ew * sc) / 2;
  const oy = PAD.t + (ah - eh * sc) / 2;
  // machine mm → pixels (Y inverted: 0 at the bottom)
  const px = (x: number) => ox + (x - Eg.x[0]) * sc;
  const py = (y: number) => oy + (Eg.y[1] - y) * sc;

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
  const zx = px(wco.x);
  const zy = py(wco.y);
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
  if (trail.length > 1) {
    ctx.lineWidth = 1.5;
    for (let i = 1; i < trail.length; i++) {
      ctx.strokeStyle = axisZAlpha(0.04 + 0.5 * (i / trail.length));
      ctx.beginPath();
      ctx.moveTo(px(trail[i - 1].x), py(trail[i - 1].y));
      ctx.lineTo(px(trail[i].x), py(trail[i].y));
      ctx.stroke();
    }
  }

  // hover crosshair
  if (hover && allowPick) {
    ctx.strokeStyle = "hsl(210 20% 92% / .25)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px(hover.x), py(Eg.y[0]));
    ctx.lineTo(px(hover.x), py(Eg.y[1]));
    ctx.moveTo(px(Eg.x[0]), py(hover.y));
    ctx.lineTo(px(Eg.x[1]), py(hover.y));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // current tool position (eased)
  const tx = px(render.x);
  const ty = py(render.y);
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
}
