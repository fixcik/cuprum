import { api } from "@/lib/api";

/** Move to the work zero on the given axes. When XY motion is requested, the tool
 *  first rises to the machine safe-Z so the traverse can't drag through stock —
 *  matching the FieldPanel click-to-move behaviour. Single-axis Z goes straight. */
export function gotoWorkZero(axes: ReadonlyArray<"x" | "y" | "z">, safeZMm: number): void {
  const wantX = axes.includes("x");
  const wantY = axes.includes("y");
  const wantZ = axes.includes("z");

  // Raise to safe Z before any XY traverse.
  if (wantX || wantY) {
    void api.machine.send(`G90 G0 Z${safeZMm}`);
  }
  const words: string[] = [];
  if (wantX) words.push("X0");
  if (wantY) words.push("Y0");
  if (words.length > 0) {
    void api.machine.send(`G90 G0 ${words.join(" ")}`);
  }
  // Z last (lower onto the work zero only after XY is reached).
  if (wantZ) {
    void api.machine.send("G90 G0 Z0");
  }
}
