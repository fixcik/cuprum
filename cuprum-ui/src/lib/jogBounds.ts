export type JogBounds = { x: [number, number]; y: [number, number]; z: [number, number] };

/** Resolve clamp bounds for a jog: machine-coordinate [lo,hi] per axis. The
 *  default is the work envelope (X,Y from 0; Z from -z to the ceiling 0) — the
 *  same range manual control has always used. Callers in a machine frame
 *  (e.g. drill touch-off before the work zero is set) pass explicit bounds. */
export function resolveJogBounds(
  env: { x: number; y: number; z: number },
  bounds?: JogBounds,
): JogBounds {
  return bounds ?? { x: [0, env.x], y: [0, env.y], z: [-env.z, 0] };
}
