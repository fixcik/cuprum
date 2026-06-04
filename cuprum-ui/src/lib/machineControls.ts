import type { MachineStateName } from "@/lib/api";

/** Motion (jog / home / spindle) is only safe when connected and the machine is
 *  idle or already jogging. Run / Hold / Alarm / Door etc. disable motion until
 *  the user resolves them (unlock / reset / cycle-start). */
export function canMove(state: MachineStateName, connected: boolean): boolean {
  return connected && (state === "idle" || state === "jog");
}
