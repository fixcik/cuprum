import { describe, expect, it } from "vitest";
import { shouldInferHomed } from "./homing";

const base = {
  homingAvailable: true,
  state: "idle" as const,
  alreadyHomed: false,
  seenAlarmSinceConnect: false,
};

describe("shouldInferHomed", () => {
  it("infers homed when homing is enabled and the machine booted into idle", () => {
    expect(shouldInferHomed(base)).toBe(true);
  });

  it("does not infer when the machine is in alarm (real cold boot, needs homing)", () => {
    expect(shouldInferHomed({ ...base, state: "alarm" })).toBe(false);
  });

  it("does not infer if alarm was seen since connect (e.g. cold boot then $X unlock)", () => {
    expect(shouldInferHomed({ ...base, state: "idle", seenAlarmSinceConnect: true })).toBe(false);
  });

  it("does not infer without homing support (no absolute frame to trust)", () => {
    expect(shouldInferHomed({ ...base, homingAvailable: false })).toBe(false);
  });

  it("does not infer mid-cycle or while moving", () => {
    for (const state of ["home", "run", "jog", "hold", "unknown"] as const) {
      expect(shouldInferHomed({ ...base, state })).toBe(false);
    }
  });

  it("is a no-op when already homed", () => {
    expect(shouldInferHomed({ ...base, alreadyHomed: true })).toBe(false);
  });
});
