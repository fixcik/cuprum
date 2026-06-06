import { api } from "@/lib/api";

/** Move to the work zero on the given axes. When XY motion is requested, the tool
 *  first rises to the machine safe-Z so the traverse can't drag through stock —
 *  matching the FieldPanel click-to-move behaviour. Single-axis Z goes straight.
 *
 *  Sends are awaited in order so the safe-Z lift is dispatched before the XY
 *  traverse even if the transport were ever reordered; a failed send is logged
 *  rather than left as an unhandled rejection. Callers may fire-and-forget. */
export async function gotoWorkZero(
  axes: ReadonlyArray<"x" | "y" | "z">,
  safeZMm: number,
): Promise<void> {
  const wantX = axes.includes("x");
  const wantY = axes.includes("y");
  const wantZ = axes.includes("z");

  try {
    // Raise to safe Z before any XY traverse.
    if (wantX || wantY) {
      await api.machine.send(`G90 G0 Z${safeZMm}`);
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
