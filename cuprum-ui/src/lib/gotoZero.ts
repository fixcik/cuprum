import { api } from "@/lib/api";

/** Move to the work zero on the given axes. When XY motion is requested, the tool
 *  first rises to the MACHINE-coordinate safe-Z (`G53 G0 Z{machineSafeZMm}`) so
 *  the traverse can't drag through stock — and so a low work zero can't drive Z
 *  above the top limit switch. The lift is skipped when the tool is already at or
 *  above safe Z (`currentMachineZ`). Single-axis Z goes straight to the work zero.
 *
 *  Sends are awaited in order so the safe-Z lift is dispatched before the XY
 *  traverse even if the transport were ever reordered; a failed send is logged
 *  rather than left as an unhandled rejection. Callers may fire-and-forget. */
export async function gotoWorkZero(
  axes: ReadonlyArray<"x" | "y" | "z">,
  machineSafeZMm: number,
  currentMachineZ: number,
): Promise<void> {
  const wantX = axes.includes("x");
  const wantY = axes.includes("y");
  const wantZ = axes.includes("z");

  try {
    // Raise to the machine-frame safe Z before any XY traverse — unless already
    // at/above it. G53 makes the move absolute in machine coordinates for one line.
    if ((wantX || wantY) && currentMachineZ < machineSafeZMm) {
      await api.machine.send(`G53 G0 Z${machineSafeZMm}`);
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
