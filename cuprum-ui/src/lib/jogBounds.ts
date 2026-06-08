export type JogBounds = { x: [number, number]; y: [number, number]; z: [number, number] };

/** Resolve clamp bounds for a jog: machine-coordinate [lo,hi] per axis. The
 *  default is the work envelope (X,Y from 0; Z from -z to the ceiling 0) — the
 *  same range manual control has always used. Callers in a machine frame
 *  (e.g. drill touch-off before the work zero is set) pass explicit bounds.
 *
 *  When the live GRBL max-travel ($130/$131/$132, read from `$$`) is known, the
 *  resolved bounds are intersected with the real firmware travel — X,Y ∈ [0, $13x]
 *  and Z ∈ [-$132, 0] — so a profile envelope set larger than the machine's actual
 *  travel can't drive an absolute jog past the soft limit (error:15) at the far
 *  edge. `firmwareTravelMm` is null until the first `$$` completes (or while
 *  disconnected); then the profile bounds are used as-is, exactly as before. */
export function resolveJogBounds(
  env: { x: number; y: number; z: number },
  bounds?: JogBounds,
  firmwareTravelMm?: [number, number, number] | null,
): JogBounds {
  const base = bounds ?? { x: [0, env.x], y: [0, env.y], z: [-env.z, 0] };
  if (!firmwareTravelMm) return base;
  const [fx, fy, fz] = firmwareTravelMm;
  // Intersect each machine-frame range with the firmware travel volume
  // (X,Y span [0, f]; Z spans [-f, 0]).
  const clip = (lo: number, hi: number, tlo: number, thi: number): [number, number] => [
    Math.max(lo, tlo),
    Math.min(hi, thi),
  ];
  return {
    x: clip(base.x[0], base.x[1], 0, fx),
    y: clip(base.y[0], base.y[1], 0, fy),
    z: clip(base.z[0], base.z[1], -fz, 0),
  };
}
