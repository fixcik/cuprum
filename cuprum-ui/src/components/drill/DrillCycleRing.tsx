import { useEffect, useRef } from "react";
import { Group, Arc } from "react-konva";
import Konva from "konva";

/** Single-sweep hole-cycle progress ring, anchored at the current hole centre and
 *  drawn inside the fit-group (panel mm space). All visual sizes are in SCREEN px,
 *  converted to mm via `pxPerMm`, so the ring stays a constant readable size at any
 *  zoom. One continuous arc from −90° clockwise spans `sweep`·360°, coloured by the
 *  current phase; a soft pulse ring breathes around it while the machine is active. */
export interface DrillCycleRingProps {
  /** Hole centre in panel mm (fit-group local coords). */
  xMm: number;
  yMm: number;
  /** Drawn hole radius in mm (same value the holes layer uses). */
  holeRadiusMm: number;
  /** Screen px per mm — keeps the ring constant-size on screen. */
  pxPerMm: number;
  /** Cycle progress 0..1 (descent→drilling→retract collapsed). */
  sweep: number;
  /** Arc colour = current phase colour (bit colour during drilling, grey if idle). */
  color: string;
  /** When false (paused / tool change) the pulse is hidden. */
  active: boolean;
}

/** Track-ring base + arc geometry, in screen px (converted to mm at render). */
const GAP_PX = 8; // ring radius = hole radius + this
const TRACK_W_PX = 2.5;
const ARC_W_PX = 2.6;

export function DrillCycleRing({
  xMm,
  yMm,
  holeRadiusMm,
  pxPerMm,
  sweep,
  color,
  active,
}: DrillCycleRingProps) {
  const pulseRef = useRef<Konva.Arc>(null);

  // Breathing pulse: animate opacity via Konva.Animation (rAF-driven).
  useEffect(() => {
    const node = pulseRef.current;
    if (!node || !active) return;
    const anim = new Konva.Animation((frame) => {
      if (!frame) return;
      const s = 0.5 + 0.5 * Math.sin(frame.time / 240);
      node.opacity(0.22 * s);
    }, node.getLayer());
    anim.start();
    return () => {
      anim.stop();
    };
  }, [active]);

  if (pxPerMm <= 0) return null;
  const k = 1 / pxPerMm;
  // Ring radius in mm: constant px gap above the (zoom-scaled) hole.
  const rMm = holeRadiusMm + GAP_PX * k;
  const trackW = TRACK_W_PX * k;
  const arcW = ARC_W_PX * k;
  const inner = rMm - arcW / 2;
  const outerArc = rMm + arcW / 2;
  const innerTrack = rMm - trackW / 2;
  const outerTrack = rMm + trackW / 2;
  // Konva Arc: `rotation` sets the start angle, `angle` sweeps clockwise. Start at
  // −90° (12 o'clock). Guard a hair above 0 so a just-started cycle shows a tick.
  const angle = Math.max(0.001, Math.min(1, sweep)) * 360;

  return (
    <Group x={xMm} y={yMm} listening={false}>
      {/* Track: full grey circle */}
      <Arc
        innerRadius={innerTrack}
        outerRadius={outerTrack}
        angle={360}
        fill="rgba(138,146,158,.28)"
        listening={false}
      />
      {/* Progress arc in the current phase colour */}
      <Arc
        innerRadius={inner}
        outerRadius={outerArc}
        angle={angle}
        rotation={-90}
        fill={color}
        listening={false}
      />
      {/* Breathing pulse (active runs only) */}
      {active && (
        <Arc
          ref={pulseRef}
          innerRadius={rMm + 3 * k}
          outerRadius={rMm + 5 * k}
          angle={360}
          fill={color}
          opacity={0}
          listening={false}
        />
      )}
    </Group>
  );
}
