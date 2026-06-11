import { describe, expect, it } from "vitest";
import {
  checkZHeadroom,
  classifyBindZ,
  DEFAULT_Z_HEADROOM_MARGIN_MM,
  zBindBand,
  type ZBindBandArgs,
  type ZHeadroomArgs,
} from "@/lib/drillZHeadroom";

// A homed frame with soft limits on, $132=73, work-zero bound at machine Z −56.18
// (wpos 0 → WCO = −56.18). Plunge 1.9 mm. Room below = −56.18 + 73 = 16.82 mm.
// Safe-Z 5 / tool-change-Z 20: highest rapid lands at machine −56.18 + 20 = −36.18,
// well under the ceiling (0) → no ceiling block.
const BASE: ZHeadroomArgs = {
  mposZ: -56.18,
  wposZ: 0,
  homed: true,
  softLimitsEnabled: true,
  maxTravelZMm: 73,
  plungeDepthMm: 1.9,
  safeZMm: 5,
  toolChangeZMm: 20,
};

describe("checkZHeadroom", () => {
  it("plenty of room within both bounds → ok, not skipped", () => {
    const r = checkZHeadroom(BASE);
    expect(r.skipped).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.block).toBeNull();
    expect(r.neededMm).toBeCloseTo(2.4); // 1.9 + 0.5 margin
    expect(r.availableMm).toBeCloseTo(16.82);
  });

  describe("floor (work-zero too low)", () => {
    it("work-zero at the very bottom of travel → blocks 'below' (not enough room)", () => {
      // WCO = −72.5, floor = −73 → only 0.5 mm below, need 2.4 → blocked.
      const r = checkZHeadroom({ ...BASE, mposZ: -72.5 });
      expect(r.skipped).toBe(false);
      expect(r.ok).toBe(false);
      expect(r.block).toBe("below");
      expect(r.availableMm).toBeCloseTo(0.5);
      expect(r.neededMm).toBeCloseTo(2.4);
    });

    it("exactly enough room (available == needed) → ok", () => {
      // Need 2.4 mm; place WCO so available is exactly 2.4: mposZ = 2.4 − 73 = −70.6.
      const r = checkZHeadroom({ ...BASE, mposZ: -70.6 });
      expect(r.availableMm).toBeCloseTo(2.4);
      expect(r.ok).toBe(true);
      expect(r.block).toBeNull();
    });

    it("one hair short of needed → blocks 'below'", () => {
      const r = checkZHeadroom({ ...BASE, mposZ: -70.61 });
      expect(r.availableMm).toBeLessThan(r.neededMm);
      expect(r.ok).toBe(false);
      expect(r.block).toBe("below");
    });

    it("respects a custom margin", () => {
      const r = checkZHeadroom({ ...BASE, mposZ: -71.5, marginMm: 1.5 });
      // available = 1.5, need = 1.9 + 1.5 = 3.4 → blocked
      expect(r.neededMm).toBeCloseTo(3.4);
      expect(r.ok).toBe(false);
      expect(r.block).toBe("below");
    });
  });

  describe("ceiling (work-zero too high)", () => {
    it("zero near the top of travel → safe/tool-change rapid punches the ceiling → 'above'", () => {
      // WCO = −0.5; highest rapid = max(5, 20) = 20 → machine −0.5 + 20 = +19.5,
      // above the ceiling (0). ceilingOverMm = 19.5 + 0.5 margin = 20.
      const r = checkZHeadroom({ ...BASE, mposZ: -0.5 });
      expect(r.skipped).toBe(false);
      expect(r.ok).toBe(false);
      expect(r.block).toBe("above");
      expect(r.ceilingOverMm).toBeCloseTo(20);
    });

    it("highest rapid sits exactly at the margin under the ceiling → ok", () => {
      // Want WCO + 20 + 0.5 == 0 → WCO = −20.5 → mposZ = −20.5.
      const r = checkZHeadroom({ ...BASE, mposZ: -20.5 });
      expect(r.ceilingOverMm).toBeCloseTo(0);
      expect(r.ok).toBe(true);
      expect(r.block).toBeNull();
    });

    it("a hair higher than the margin → blocks 'above'", () => {
      const r = checkZHeadroom({ ...BASE, mposZ: -20.49 });
      expect(r.ceilingOverMm).toBeGreaterThan(0);
      expect(r.ok).toBe(false);
      expect(r.block).toBe("above");
    });

    it("uses max(safeZ, toolChangeZ) — the highest rapid drives the ceiling", () => {
      // Drop the tool-change-Z below safe-Z; safe-Z (5) now dominates. WCO = −2 →
      // machine 5 − 2 = +3 over the ceiling → still blocks 'above'.
      const r = checkZHeadroom({ ...BASE, mposZ: -2, toolChangeZMm: 1 });
      expect(r.block).toBe("above");
      expect(r.ceilingOverMm).toBeCloseTo(-2 + 5 + 0.5);
    });
  });

  it("both bounds violated (tiny envelope) → floor takes precedence ('below')", () => {
    // $132 = 4 mm; plunge 1.9 needs 2.4 down, tool-change 20 wants to rise far above
    // the ceiling — no zero can satisfy both. WCO = −2: down room = 2 (<2.4 → floor
    // fails), and −2 + 20 + 0.5 = 18.5 > 0 (ceiling fails). Floor wins.
    const r = checkZHeadroom({ ...BASE, maxTravelZMm: 4, mposZ: -2 });
    expect(r.ok).toBe(false);
    expect(r.block).toBe("below");
    expect(r.availableMm).toBeLessThan(r.neededMm);
    expect(r.ceilingOverMm).toBeGreaterThan(0);
  });

  it("uses WCO (mpos − wpos), not raw mpos — robust after a probe retract", () => {
    // Same bound zero (machine −56.18) but reported after a +5 mm retract:
    // mpos −51.18, wpos +5 → WCO −56.18, identical room.
    const r = checkZHeadroom({ ...BASE, mposZ: -51.18, wposZ: 5 });
    expect(r.availableMm).toBeCloseTo(16.82);
    expect(r.ok).toBe(true);
    expect(r.block).toBeNull();
  });

  it("default margin is 0.5 mm", () => {
    expect(DEFAULT_Z_HEADROOM_MARGIN_MM).toBe(0.5);
  });

  describe("skips when the envelope is not computable (treated as ok)", () => {
    it("not homed", () => {
      const r = checkZHeadroom({ ...BASE, mposZ: -72.9, homed: false });
      expect(r.skipped).toBe(true);
      expect(r.ok).toBe(true);
      expect(r.block).toBeNull();
      expect(r.availableMm).toBe(0);
      expect(r.ceilingOverMm).toBe(0);
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

// Same geometry as BASE, minus the live position (the band is position-independent).
const BAND_BASE: ZBindBandArgs = {
  homed: true,
  softLimitsEnabled: true,
  maxTravelZMm: 73,
  plungeDepthMm: 1.9,
  safeZMm: 5,
  toolChangeZMm: 20,
};

describe("zBindBand", () => {
  it("derives the safe machine-Z band (inverse of checkZHeadroom)", () => {
    const b = zBindBand(BAND_BASE);
    expect(b.known).toBe(true);
    // floor: 1.9 + 0.5 − 73 = −70.6 ; ceiling: −max(5,20) − 0.5 = −20.5
    expect(b.minZ).toBeCloseTo(-70.6);
    expect(b.maxZ).toBeCloseTo(-20.5);
  });

  it("band edges agree with checkZHeadroom's pass/fail boundaries", () => {
    const b = zBindBand(BAND_BASE);
    // Binding exactly at each edge is ok; a hair beyond fails the matching bound.
    const at = (z: number) => checkZHeadroom({ ...BASE, mposZ: z, wposZ: 0 });
    expect(at(b.minZ).ok).toBe(true);
    expect(at(b.minZ - 0.01).block).toBe("below");
    expect(at(b.maxZ).ok).toBe(true);
    expect(at(b.maxZ + 0.01).block).toBe("above");
  });

  it("ceiling is driven by the highest rapid — max(safeZ, toolChangeZ)", () => {
    const b = zBindBand({ ...BAND_BASE, safeZMm: 30, toolChangeZMm: 20 });
    expect(b.maxZ).toBeCloseTo(-30.5); // safe-Z (30) now dominates
  });

  it("respects a custom margin", () => {
    const b = zBindBand({ ...BAND_BASE, marginMm: 1.5 });
    expect(b.minZ).toBeCloseTo(1.9 + 1.5 - 73);
    expect(b.maxZ).toBeCloseTo(-20 - 1.5);
  });

  it("unknown when the envelope is not computable", () => {
    for (const patch of [
      { homed: false },
      { softLimitsEnabled: false as const },
      { softLimitsEnabled: null },
      { maxTravelZMm: null },
      { maxTravelZMm: 0 },
    ]) {
      const b = zBindBand({ ...BAND_BASE, ...patch });
      expect(b.known).toBe(false);
      expect(b.minZ).toBe(-Infinity);
      expect(b.maxZ).toBe(Infinity);
    }
  });
});

describe("classifyBindZ", () => {
  const band = zBindBand(BAND_BASE); // [−70.6, −20.5]

  it("inside the band → null", () => {
    expect(classifyBindZ(band, -45)).toBeNull();
    expect(classifyBindZ(band, band.minZ)).toBeNull();
    expect(classifyBindZ(band, band.maxZ)).toBeNull();
  });

  it("below the floor → 'below'", () => {
    expect(classifyBindZ(band, band.minZ - 0.01)).toBe("below");
  });

  it("above the ceiling → 'above'", () => {
    expect(classifyBindZ(band, band.maxZ + 0.01)).toBe("above");
  });

  it("unknown band never blocks", () => {
    const unknown = zBindBand({ ...BAND_BASE, homed: false });
    expect(classifyBindZ(unknown, 0)).toBeNull();
    expect(classifyBindZ(unknown, -1000)).toBeNull();
  });
});
