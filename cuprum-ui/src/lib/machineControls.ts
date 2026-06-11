import type { MachineStateName } from "@/lib/api";

/** Motion (jog / home / spindle) is only safe when connected and the machine is
 *  idle or already jogging. Run / Hold / Alarm / Door etc. disable motion until
 *  the user resolves them (unlock / reset / cycle-start). */
export function canMove(state: MachineStateName, connected: boolean): boolean {
  return connected && (state === "idle" || state === "jog");
}

/** Binding a work zero (XY `G10 L20`, or a per-tool Z probe / manual touch-off) must
 *  happen on a STATIONARY machine — stricter than `canMove`: jogging is motion too, so
 *  a zero set mid-jog would latch a stale, wrong position. Only connected + idle. */
export function canSetZero(state: MachineStateName, connected: boolean): boolean {
  return connected && state === "idle";
}
