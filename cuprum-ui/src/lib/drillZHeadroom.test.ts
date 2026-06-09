import { describe, expect, it } from "vitest";
import {
  checkZHeadroom,
  DEFAULT_Z_HEADROOM_MARGIN_MM,
  type ZHeadroomArgs,
} from "@/lib/drillZHeadroom";

// A homed frame with soft limits on, $132=73, work-zero bound at machine Z −56.18
// (wpos 0 → WCO = −56.18). Plunge 1.9 mm. Room below = −56.18 + 73 = 16.82 mm.
const BASE: ZHeadroomArgs = {
  mposZ: -56.18,
  wposZ: 0,
  homed: true,
  softLimitsEnabled: true,
  maxTravelZMm: 73,
  plungeDepthMm: 1.9,
};

describe("checkZHeadroom", () => {
  it("plenty of room below the work-zero → ok, not skipped", () => {
    const r = checkZHeadroom(BASE);
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.neededMm).toBeCloseTo(2.4); // 1.9 + 0.5 margin
    expect(r.availableMm).toBeCloseTo(16.82);
  });

  it("work-zero at the very bottom of travel → blocks (not enough room)", () => {
    // WCO = −72.5, floor = −73 → only 0.5 mm below, need 2.4 → blocked.
    const r = checkZHeadroom({ ...BASE, mposZ: -72.5 });
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.availableMm).toBeCloseTo(0.5);
    expect(r.neededMm).toBeCloseTo(2.4);
  });

  it("exactly enough room (available == needed) → ok", () => {
    // Need 2.4 mm; place WCO so available is exactly 2.4: mposZ = 2.4 − 73 = −70.6.
    const r = checkZHeadroom({ ...BASE, mposZ: -70.6 });
    expect(r.availableMm).toBeCloseTo(2.4);
    expect(r.ok).toBe(true);
  });

  it("one hair short of needed → blocks", () => {
    const r = checkZHeadroom({ ...BASE, mposZ: -70.61 });
    expect(r.availableMm).toBeLessThan(r.neededMm);
    expect(r.ok).toBe(false);
  });

  it("uses WCO (mpos − wpos), not raw mpos — robust after a probe retract", () => {
    // Same bound zero (machine −56.18) but reported after a +5 mm retract:
    // mpos −51.18, wpos +5 → WCO −56.18, identical room.
    const r = checkZHeadroom({ ...BASE, mposZ: -51.18, wposZ: 5 });
    expect(r.availableMm).toBeCloseTo(16.82);
    expect(r.ok).toBe(true);
  });

  it("respects a custom margin", () => {
    const r = checkZHeadroom({ ...BASE, mposZ: -71.5, marginMm: 1.5 });
    // available = 1.5, need = 1.9 + 1.5 = 3.4 → blocked
    expect(r.neededMm).toBeCloseTo(3.4);
    expect(r.ok).toBe(false);
  });

  it("default margin is 0.5 mm", () => {
    expect(DEFAULT_Z_HEADROOM_MARGIN_MM).toBe(0.5);
  });

  describe("skips when the floor is not computable (treated as ok)", () => {
    it("not homed", () => {
      const r = checkZHeadroom({ ...BASE, mposZ: -72.9, homed: false });
      expect(r.skipped).toBe(true);
      expect(r.ok).toBe(true);
      expect(r.availableMm).toBe(0);
    });

    it("soft limits off", () => {
      const r = checkZHeadroom({ ...BASE, mposZ: -72.9, softLimitsEnabled: false });
      expect(r.skipped).toBe(true);
      expect(r.ok).toBe(true);
    });

    it("soft limits unknown (null)", () => {
      const r = checkZHeadroom({ ...BASE, mposZ: -72.9, softLimitsEnabled: null });
      expect(r.skipped).toBe(true);
      expect(r.ok).toBe(true);
    });

    it("$132 unknown (null) or non-positive", () => {
      expect(checkZHeadroom({ ...BASE, maxTravelZMm: null }).skipped).toBe(true);
      expect(checkZHeadroom({ ...BASE, maxTravelZMm: 0 }).skipped).toBe(true);
    });
  });
});
