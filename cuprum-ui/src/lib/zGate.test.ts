import { describe, expect, it } from "vitest";
import { checkZGate } from "./zGate";

describe("checkZGate", () => {
  it("returns not-zeroed when workZeroMachineZ is null", () => {
    const r = checkZGate(null, 5);
    expect(r).toEqual({ valid: false, reason: "not-zeroed" });
  });

  it("returns valid when retract is below the ceiling", () => {
    // workZero=-30, safeZ=5 → retract=-25 ≤ 0
    const r = checkZGate(-30, 5);
    expect(r).toEqual({ valid: true });
  });

  it("returns too-high when retract exceeds machine ceiling", () => {
    // workZero=-3, safeZ=5 → retract=+2 > 0
    const r = checkZGate(-3, 5);
    expect(r).toEqual({ valid: false, reason: "too-high", retractMachineZ: 2, safeZMm: 5 });
  });

  it("returns valid at exact boundary (retract = 0)", () => {
    // workZero=-5, safeZ=5 → retract=0 ≤ 0
    const r = checkZGate(-5, 5);
    expect(r).toEqual({ valid: true });
  });
});
