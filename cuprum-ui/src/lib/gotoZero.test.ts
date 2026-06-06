import { describe, expect, it } from "vitest";
import { safeRetractMachineZ } from "./gotoZero";

describe("safeRetractMachineZ", () => {
  it("retracts a clearance above the work-zero surface", () => {
    // Work zero ~42 mm below the ceiling, clearance 5 mm, ceiling −1 mm.
    // Target = −42 + 5 = −37, which is 5 mm above the surface and below the cap.
    expect(safeRetractMachineZ(-42, 5, -1)).toBe(-37);
  });

  it("caps the retract at the machine ceiling", () => {
    // Work zero close to the top: clearance would push above the ceiling, so cap.
    expect(safeRetractMachineZ(-3, 5, -1)).toBe(-1);
  });

  it("falls back to the ceiling when Z is not zeroed (wcoZ ≈ 0)", () => {
    // Un-zeroed Z → wcoZ ≈ 0 → 0 + 5 = 5 is above the ceiling → capped to −1.
    expect(safeRetractMachineZ(0, 5, -1)).toBe(-1);
  });

  it("uses the clearance target when it stays below the ceiling exactly", () => {
    // wcoZ + clearance == ceiling → the cap is a no-op, target is the sum.
    expect(safeRetractMachineZ(-6, 5, -1)).toBe(-1);
  });
});
