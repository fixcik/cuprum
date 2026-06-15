import { Group, Line, Circle, Rect, Text } from "react-konva";
import { useUnitFormat } from "@/i18n/useUnitFormat";

/** A measurement endpoint: panel-mm position + whether it locked onto a real
 *  feature (board corner / edge / centre), which drives the dashed lock ring. */
export interface MeasurePoint {
  x: number;
  y: number;
  feature: boolean;
}

// Measure overlay styling — a copper core (--primary) over a dark casing, so the
// line and reticles stay legible over any canvas colour. All widths and radii are
// SCREEN px (constant under zoom); endpoints live in panel mm and are projected to
// screen space. Ported from the design inspector (LayerStack) measure overlay;
// constants are duplicated here to keep this module self-contained.
const M_CORE = "hsl(var(--primary))"; // copper accent
const M_CASE = "rgba(0,0,0,0.6)"; // dark halo/casing under the copper
const M_LINE_CASE = 5; // measure line — casing width
const M_LINE_CORE = 2; // measure line — copper width
const M_LEG_CORE = 1.5; // ΔX/ΔY leg — copper width
const M_LEG_CASE = 3.5; // ΔX/ΔY leg — casing width
const M_RING_R = 10; // reticle ring radius
const M_RING_CASE = 5; // reticle ring — casing width
const M_RING_CORE = 2; // reticle ring — copper width
const M_CROSS_ARM = 16; // crosshair half-arm length (32px tip-to-tip)
const M_CROSS_CASE = 4; // crosshair — casing width
const M_CROSS_CORE = 1.5; // crosshair — copper width
const M_DOT_R = 2.5; // centre dot radius
const M_FEATURE_R = 15; // dashed lock ring shown when snapped to a feature
const MEASURE_LABEL_BG = "hsl(222 16% 9% / 0.92)";
const MEASURE_LABEL_BORDER = "hsl(var(--border))";
const MEASURE_LABEL_FG = "rgba(255,255,255,0.95)";
const MEASURE_LABEL_SUB = "rgba(255,255,255,0.6)";

/** A snap reticle: dark casing under a copper core, all in screen px so it stays
 *  crisp at any zoom. A dashed lock ring marks a feature snap. */
function Reticle({ cx, cy, feature }: { cx: number; cy: number; feature: boolean }) {
  return (
    <Group x={cx} y={cy} listening={false}>
      {feature && (
        <Circle radius={M_FEATURE_R} stroke={M_CORE} strokeWidth={1.25} dash={[3, 3]} opacity={0.9} />
      )}
      <Circle radius={M_RING_R} stroke={M_CASE} strokeWidth={M_RING_CASE} />
      <Circle radius={M_RING_R} stroke={M_CORE} strokeWidth={M_RING_CORE} />
      <Line points={[-M_CROSS_ARM, 0, M_CROSS_ARM, 0]} stroke={M_CASE} strokeWidth={M_CROSS_CASE} lineCap="round" />
      <Line points={[0, -M_CROSS_ARM, 0, M_CROSS_ARM]} stroke={M_CASE} strokeWidth={M_CROSS_CASE} lineCap="round" />
      <Line points={[-M_CROSS_ARM, 0, M_CROSS_ARM, 0]} stroke={M_CORE} strokeWidth={M_CROSS_CORE} lineCap="round" />
      <Line points={[0, -M_CROSS_ARM, 0, M_CROSS_ARM]} stroke={M_CORE} strokeWidth={M_CROSS_CORE} lineCap="round" />
      <Circle radius={M_DOT_R} fill={M_CORE} stroke={M_CASE} strokeWidth={1.5} />
    </Group>
  );
}

/** Konva measure overlay for the panel-blank canvas. Rendered in screen px on an
 *  untransformed layer (NOT inside the fit-group), so widths/radii stay constant
 *  under zoom; endpoints are projected mm → screen via `originX + mm * pxPerMm`.
 *
 *  `a` is the placed start; while picking the end, `hover` is the live second point.
 *  Once both are placed, `hover` is the prospective NEXT start (shown faint). */
export function MeasureOverlay({
  a,
  b,
  hover,
  width,
  height,
  originX,
  originY,
  pxPerMm,
}: {
  a: MeasurePoint | null;
  b: MeasurePoint | null;
  hover: MeasurePoint | null;
  width: number;
  height: number;
  originX: number;
  originY: number;
  pxPerMm: number;
}) {
  const { fmtLen } = useUnitFormat();
  if (pxPerMm <= 0) return null;

  const toScreen = (p: { x: number; y: number }): [number, number] => [
    originX + p.x * pxPerMm,
    originY + p.y * pxPerMm,
  ];

  const measuring = !!a && !b;
  const liveB: MeasurePoint | null = b ?? (measuring && hover ? hover : null);
  const aS = a ? toScreen(a) : null;
  const bS = liveB ? toScreen(liveB) : null;
  const dxmm = a && liveB ? liveB.x - a.x : 0;
  const dymm = a && liveB ? liveB.y - a.y : 0;
  const dist = Math.hypot(dxmm, dymm);
  const showStartHover = hover && !measuring; // hover = next start point

  const labelW = 118;
  const labelH = 34;
  const labelOffX = 12;
  const labelOffY = -labelH - 8;
  let labelX = bS ? bS[0] + labelOffX : 0;
  let labelY = bS ? bS[1] + labelOffY : 0;
  if (bS) {
    if (labelX + labelW > width - 4) labelX = bS[0] - labelW - labelOffX;
    if (labelY < 4) labelY = bS[1] + 12;
  }
  // ΔX/ΔY legs: catheti of the right triangle A → (Bx,Ay) → B, in screen px.
  const legPts = aS && bS ? [aS[0], aS[1], bS[0], aS[1], bS[0], bS[1]] : [];

  return (
    <Group listening={false}>
      {/* Faint scrim while measuring, so the overlay lifts off the canvas. */}
      <Rect x={0} y={0} width={width} height={height} fill="rgba(0,0,0,0.07)" />
      {aS && bS && (
        <>
          <Line points={legPts} stroke={M_CASE} strokeWidth={M_LEG_CASE} dash={[6, 5]} lineCap="round" opacity={0.85} />
          <Line points={legPts} stroke={M_CORE} strokeWidth={M_LEG_CORE} dash={[6, 5]} lineCap="round" opacity={0.85} />
          <Line points={[aS[0], aS[1], bS[0], bS[1]]} stroke={M_CASE} strokeWidth={M_LINE_CASE} lineCap="round" />
          <Line points={[aS[0], aS[1], bS[0], bS[1]]} stroke={M_CORE} strokeWidth={M_LINE_CORE} lineCap="round" />
        </>
      )}
      {aS && a && <Reticle cx={aS[0]} cy={aS[1]} feature={a.feature} />}
      {bS && liveB && <Reticle cx={bS[0]} cy={bS[1]} feature={liveB.feature} />}
      {showStartHover && hover && (() => {
        const [hx, hy] = toScreen(hover);
        // Prospective NEXT start — faint, so it reads as a hint, not a placed
        // endpoint (avoids two equal reticles after a measure).
        return (
          <Group opacity={0.5}>
            <Reticle cx={hx} cy={hy} feature={hover.feature} />
          </Group>
        );
      })()}
      {aS && bS && (
        <Group x={labelX} y={labelY}>
          <Rect x={0} y={0} width={labelW} height={labelH} cornerRadius={6} fill={MEASURE_LABEL_BG} stroke={MEASURE_LABEL_BORDER} strokeWidth={1} />
          <Text x={8} y={6} text={fmtLen(dist)} fill={MEASURE_LABEL_FG} fontSize={11} fontStyle="600" />
          <Text x={8} y={20} text={`ΔX ${fmtLen(dxmm)} · ΔY ${fmtLen(dymm)}`} fill={MEASURE_LABEL_SUB} fontSize={9} />
        </Group>
      )}
    </Group>
  );
}
