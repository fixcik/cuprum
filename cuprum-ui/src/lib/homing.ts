import type { MachineStateName } from "@/lib/api";

/** Whether a just-connected machine should be treated as already homed without
 *  running a cycle.
 *
 *  With homing enabled ($22=1) GRBL boots into ALARM and refuses motion until a
 *  homing cycle runs — so if, shortly after connecting, the controller instead
 *  reports a plain `idle`, it was homed earlier and kept its machine reference
 *  across this (power-retained) reconnect. A real cold boot would still be in
 *  ALARM, so it stays unhomed and the user is prompted to home.
 *
 *  Gated on `homingAvailable` because without homing there is no absolute frame
 *  to trust; only `idle` qualifies (mid-cycle `home`/`run`/`jog` are handled by
 *  the normal home→idle transition).
 *
 *  `seenAlarmSinceConnect` is the critical guard: if the machine was EVER in
 *  ALARM since connecting, it cold-booted unreferenced — a later `idle` only
 *  means the user cleared the alarm with `$X` (unlock without homing), which does
 *  NOT establish a machine frame. Only a machine that was never in alarm is
 *  trustworthy as already-homed. */
export function shouldInferHomed(args: {
  homingAvailable: boolean;
  state: MachineStateName;
  alreadyHomed: boolean;
  seenAlarmSinceConnect: boolean;
}): boolean {
  const { homingAvailable, state, alreadyHomed, seenAlarmSinceConnect } = args;
  return !alreadyHomed && !seenAlarmSinceConnect && homingAvailable && state === "idle";
}
