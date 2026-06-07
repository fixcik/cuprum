import { useLayoutEffect, useRef } from "react";
import { Group, Line, Circle, Rect, Text } from "react-konva";
import Konva from "konva";

/** Live machine-position marker, rendered INSIDE the fit-group (panel mm space)
 *  so it shares the holes' stage∘fit transform. Visual sizes are in screen px,
 *  divided by `pxPerMm` to stay constant on screen. Tweens toward each new sample
 *  so 5 Hz polling looks smooth. During a run it carries a dark "pill" with the
 *  current cycle phase + live X/Y/Z; outside a run, just the coordinates. */
export interface MachineMarkerProps {
  /** Position in panel mm (fit-group local coords). */
  xMm: number;
  yMm: number;
  /** Screen px per mm (stage scale × fit) — keeps the marker constant-size. */
  pxPerMm: number;
  /** Work coordinates (mm) for the readout. */
  workX: number;
  workY: number;
  /** Work Z (mm); omitted → not shown. */
  workZ?: number;
  /** Panel width in mm — used to flip the pill left near the right canvas edge. */
  panelWidthMm: number;
  /** Current cycle phase label (e.g. "СВЕРЛОВКА"); omitted → no phase row. */
  phaseLabel?: string;
  /** Colour of the phase dot + phase text. Defaults to cyan. */
  phaseColor?: string;
}

const CYAN = "#46e0ff";
const ARM_PX = 6; // crosshair stroke length beyond the ring gap
const GAP_PX = 8; // matches DrillCycleRing ring radius gap
const DOT_PX = 1.6;
const STROKE_PX = 1.5;
const TWEEN_S = 0.18;

const PILL_H_PX = 32;
const PILL_PAD_PX = 10;
const PHASE_FONT_PX = 9;
const COORD_FONT_PX = 11;

export function MachineMarker({
  xMm,
  yMm,
  pxPerMm,
  workX,
  workY,
  workZ,
  panelWidthMm,
  phaseLabel,
  phaseColor = CYAN,
}: MachineMarkerProps) {
  const ref = useRef<Konva.Group>(null);
  const seeded = useRef(false);

  // Seed position synchronously before paint so the marker never flashes at (0,0).
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (!seeded.current) {
      node.x(xMm);
      node.y(yMm);
      seeded.current = true;
      return;
    }
    const tween = new Konva.Tween({
      node,
      x: xMm,
      y: yMm,
      duration: TWEEN_S,
      easing: Konva.Easings.Linear,
    });
    tween.play();
    return () => tween.destroy();
  }, [xMm, yMm]);

  const k = pxPerMm > 0 ? 1 / pxPerMm : 0;
  const arm = ARM_PX * k;
  const gap = GAP_PX * k;
  const dot = DOT_PX * k;

  // Pill geometry. Measure each row with the font it is drawn in so text never
  // overflows the backing (handoff requirement).
  const coords =
    `X ${workX.toFixed(1)}   Y ${workY.toFixed(1)}` +
    (workZ !== undefined ? `   Z ${workZ.toFixed(1)}` : "");
  const phaseTxt = phaseLabel ? phaseLabel.toUpperCase() : null;
  const wPhase = phaseTxt ? measureText(phaseTxt, `700 ${PHASE_FONT_PX}px`) + 12 : 0;
  const wCoord = measureText(coords, `600 ${COORD_FONT_PX}px`);
  const pillWpx = Math.max(wPhase, wCoord) + PILL_PAD_PX * 2;
  const pillW = pillWpx * k;
  const pillH = PILL_H_PX * k;
  const pad = PILL_PAD_PX * k;

  // Default: pill to the right of the marker; flip left near the right edge. The
  // group is translated to (xMm,yMm), so the pill is laid out in LOCAL coords; the
  // edge test compares the marker's absolute mm x against the panel width.
  const rightX = gap + 12 * k;
  const flip = xMm + rightX + pillW > panelWidthMm;
  const px = flip ? -(gap + 12 * k) - pillW : rightX;
  const py = -pillH / 2;

  return (
    <Group ref={ref} listening={false}>
      {/* cyan crosshair: 4 ticks with a gap from the ring radius */}
      <Line points={[-gap - arm, 0, -gap, 0]} stroke={CYAN} strokeWidth={STROKE_PX} strokeScaleEnabled={false} />
      <Line points={[gap, 0, gap + arm, 0]} stroke={CYAN} strokeWidth={STROKE_PX} strokeScaleEnabled={false} />
      <Line points={[0, -gap - arm, 0, -gap]} stroke={CYAN} strokeWidth={STROKE_PX} strokeScaleEnabled={false} />
      <Line points={[0, gap, 0, gap + arm]} stroke={CYAN} strokeWidth={STROKE_PX} strokeScaleEnabled={false} />
      <Circle x={0} y={0} radius={dot} fill={CYAN} />

      {/* pill: dark backing + cyan border */}
      <Rect
        x={px}
        y={py}
        width={pillW}
        height={pillH}
        cornerRadius={6 * k}
        fill="rgba(8,10,14,.92)"
        stroke="rgba(70,224,255,.30)"
        strokeWidth={1}
        strokeScaleEnabled={false}
      />
      {phaseTxt && (
        <>
          <Circle x={px + pad + 2.5 * k} y={py + 11 * k} radius={2.5 * k} fill={phaseColor} />
          <Text
            x={px + pad + 9 * k}
            y={py + 7 * k}
            text={phaseTxt}
            fontSize={PHASE_FONT_PX * k}
            fontStyle="700"
            fill={phaseColor}
          />
        </>
      )}
      <Text
        x={px + pad}
        y={py + (phaseTxt ? 18 * k : (pillH - COORD_FONT_PX * k) / 2)}
        text={coords}
        fontSize={COORD_FONT_PX * k}
        fontStyle="600"
        fill={CYAN}
      />
    </Group>
  );
}

/** Measure text width in px using a shared offscreen 2D context. Same font string
 *  the Konva Text is drawn with, so the pill backing always fits the text. */
let _measureCtx: CanvasRenderingContext2D | null = null;
function measureText(text: string, font: string): number {
  if (!_measureCtx) {
    _measureCtx = document.createElement("canvas").getContext("2d");
  }
  if (!_measureCtx) return text.length * 7; // fallback estimate
  _measureCtx.font = `${font} ui-sans-serif, system-ui, sans-serif`;
  return _measureCtx.measureText(text).width;
}
