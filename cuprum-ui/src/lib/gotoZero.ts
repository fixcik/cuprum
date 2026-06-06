import { api } from "@/lib/api";

/** Machine-Z target for a safe retract: a modest clearance above the work-zero
 *  surface, capped at the machine ceiling so it never reaches the top limit.
 *  wcoZ = machine Z of work-zero (mpos.z − wpos.z). All in machine coords (≤0 top=0). */
export function safeRetractMachineZ(wcoZ: number, clearanceMm: number, ceilingMm: number): number {
  return Math.min(wcoZ + clearanceMm, ceilingMm);
}

/** Move to the work zero on the given axes. When XY motion is requested, the tool
 *  first rises to the already-computed machine-frame retract Z
 *  (`G53 G0 Z{retractMachineZ}`) so the traverse can't drag through stock. Callers
 *  compute `retractMachineZ` from the live status (clearance above work zero,
 *  capped at the machine ceiling — see `safeRetractMachineZ`). The lift is skipped
 *  when the tool is already at or above the retract Z (`currentMachineZ`).
 *  Single-axis Z goes straight to the work zero.
 *
 *  Sends are awaited in order so the safe-Z lift is dispatched before the XY
 *  traverse even if the transport were ever reordered; a failed send is logged
 *  rather than left as an unhandled rejection. Callers may fire-and-forget.
 *
 *  Requires a homed machine: G53 references the machine frame, which is only
 *  meaningful after `$H`. The `homed` guard makes that contract enforceable here,
 *  not just in the callers' disabled-state. */
export async function gotoWorkZero(
  axes: ReadonlyArray<"x" | "y" | "z">,
  retractMachineZ: number,
  currentMachineZ: number,
  homed: boolean,
): Promise<void> {
  if (!homed) return;
  const wantX = axes.includes("x");
  const wantY = axes.includes("y");
  const wantZ = axes.includes("z");

  try {
    // Raise to the machine-frame retract Z before any XY traverse — unless already
    // at/above it. G53 makes the move absolute in machine coordinates for one line.
    if ((wantX || wantY) && currentMachineZ < retractMachineZ) {
      await api.machine.send(`G53 G0 Z${retractMachineZ}`);
    }
    const words: string[] = [];
    if (wantX) words.push("X0");
    if (wantY) words.push("Y0");
    if (words.length > 0) {
      await api.machine.send(`G90 G0 ${words.join(" ")}`);
    }
    // Z last (lower onto the work zero only after XY is reached).
    if (wantZ) {
      await api.machine.send("G90 G0 Z0");
    }
  } catch (e) {
    console.error("gotoWorkZero failed", e);
  }
}
