/** Result of the Z-gate check.
 *  - valid: the retract height fits inside the machine envelope.
 *  - not-zeroed: workZeroMachineZ is null; touch-off has not been done.
 *  - too-high: workZeroMachineZ + safeZMm > 0 (retract would exceed machine ceiling). */
export type ZGateResult =
  | { valid: true }
  | { valid: false; reason: "not-zeroed" }
  | { valid: false; reason: "too-high"; retractMachineZ: number; safeZMm: number };

/** Check whether a drill run is safe to start from a machine-coordinates perspective.
 *
 * GRBL's machine Z=0 is the physical top-of-travel (homed position). All work
 * positions are negative (tool descends from 0). A safe-Z retract therefore lives
 * at machineZ = workZeroMachineZ + safeZMm. For the retract to stay inside the
 * envelope that value must be ≤ 0.
 *
 * @param workZeroMachineZ  MPos Z captured when the operator touched off (null = not done).
 * @param safeZMm           safeZMm from CncProfile (always positive, e.g. 5 mm).
 */
export function checkZGate(workZeroMachineZ: number | null, safeZMm: number): ZGateResult {
  if (workZeroMachineZ === null) return { valid: false, reason: "not-zeroed" };
  const retractMachineZ = workZeroMachineZ + safeZMm;
  if (retractMachineZ > 0) return { valid: false, reason: "too-high", retractMachineZ, safeZMm };
  return { valid: true };
}
