import { describe, expect, it } from "vitest";
import { shouldInferHomed } from "./homing";

describe("shouldInferHomed", () => {
  it("infers homed when homing is enabled and the machine booted into idle", () => {
    expect(shouldInferHomed({ homingAvailable: true, state: "idle", alreadyHomed: false })).toBe(
      true,
    );
  });

  it("does not infer when the machine is in alarm (real cold boot, needs homing)", () => {
    expect(shouldInferHomed({ homingAvailable: true, state: "alarm", alreadyHomed: false })).toBe(
      false,
    );
  });

  it("does not infer without homing support (no absolute frame to trust)", () => {
    expect(shouldInferHomed({ homingAvailable: false, state: "idle", alreadyHomed: false })).toBe(
      false,
    );
  });

  it("does not infer mid-cycle or while moving", () => {
    for (const state of ["home", "run", "jog", "hold", "unknown"] as const) {
      expect(shouldInferHomed({ homingAvailable: true, state, alreadyHomed: false })).toBe(false);
    }
  });

  it("is a no-op when already homed", () => {
    expect(shouldInferHomed({ homingAvailable: true, state: "idle", alreadyHomed: true })).toBe(
      false,
    );
  });
});
