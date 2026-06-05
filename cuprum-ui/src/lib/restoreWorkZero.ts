import { api } from "@/lib/api";
import { useMachine } from "@/machineStore";
import { restoreZeroGcode } from "@/lib/workZero";

const TIMEOUT_MS = 90_000;
const POLL_MS = 200;

/** Home ($H), wait until GRBL returns to Idle, then set the G54 offset so the
 *  saved work XY-zero is restored. Throws on timeout/alarm. */
export async function restoreWorkZero(z: { x: number; y: number }): Promise<void> {
  await api.machine.home(); // sends $H

  // First, wait until the machine actually leaves idle/jog and enters a homing
  // state (home/run), so we don't mistake a pre-homing idle for done.
  const guardStart = Date.now();
  const GUARD_MS = 3_000;
  for (;;) {
    const st = useMachine.getState().status.state;
    if (st === "home" || st === "run") break;
    if (Date.now() - guardStart > GUARD_MS) break; // firmware may skip intermediate states
    await new Promise<void>((r) => setTimeout(r, POLL_MS));
  }

  // Now wait for homing to complete: state settles back to idle.
  const start = Date.now();
  for (;;) {
    const st = useMachine.getState().status.state;
    if (st === "idle" || st === "jog") break;
    if (st === "alarm") throw new Error("alarm during homing");
    if (Date.now() - start > TIMEOUT_MS) throw new Error("homing timeout");
    await new Promise<void>((r) => setTimeout(r, POLL_MS));
  }

  await api.machine.send(restoreZeroGcode(z));
}
