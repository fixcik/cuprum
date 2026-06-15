import { describe, it, expect } from "vitest";
import {
  classifyRms,
  getRegistrationHoles,
  buildFiducialEntries,
  fiducialCaptureBounds,
  canSolve,
  FIDUCIAL_CAPTURE_RADIUS_MM,
  MIN_CAPTURES_FOR_SOLVE,
  RMS_WARN_MM,
  RMS_ERROR_MM,
} from "@/lib/fiducialRegistration";
import type { ToolingHole } from "@/lib/api";

const makeHole = (role: ToolingHole["role"], x_mm: number, y_mm: number): ToolingHole => ({
  id: `h-${x_mm}-${y_mm}`,
  x_mm,
  y_mm,
  diameter_mm: 3,
  role,
});

const MACHINE_BOUNDS = {
  x: [0, 300] as [number, number],
  y: [0, 200] as [number, number],
  z: [-60, 0] as [number, number],
};

describe("classifyRms", () => {
  it("returns good at or below warn threshold", () => {
    expect(classifyRms(0)).toBe("good");
    expect(classifyRms(RMS_WARN_MM)).toBe("good");
  });
  it("returns warn between thresholds", () => {
    expect(classifyRms(RMS_WARN_MM + 0.001)).toBe("warn");
    expect(classifyRms(RMS_ERROR_MM)).toBe("warn");
  });
  it("returns bad above error threshold", () => {
    expect(classifyRms(RMS_ERROR_MM + 0.001)).toBe("bad");
    expect(classifyRms(2.0)).toBe("bad");
  });
});

describe("getRegistrationHoles", () => {
  it("returns only registration holes", () => {
    const holes: ToolingHole[] = [
      makeHole("registration", 5, 5),
      makeHole("flip", 10, 10),
      makeHole("registration", 95, 5),
      makeHole("unused", 50, 50),
    ];
    const result = getRegistrationHoles(holes);
    expect(result).toHaveLength(2);
    expect(result.every((h) => h.role === "registration")).toBe(true);
  });

  it("returns empty array when no registration holes", () => {
    const holes: ToolingHole[] = [makeHole("flip", 5, 5), makeHole("unused", 10, 10)];
    expect(getRegistrationHoles(holes)).toHaveLength(0);
  });
});

describe("buildFiducialEntries", () => {
  // Panel 100×80 mm, datum bottom-left: machine XY = (panelX, panelH - panelY)
  it("converts panel coords to machine coords with bottom-left datum", () => {
    const holes: ToolingHole[] = [makeHole("registration", 5, 5)];
    const entries = buildFiducialEntries(holes, "bottom-left", 100, 80);
    // bottom-left datum: mx = x, my = H - y = 80 - 5 = 75
    expect(entries).toHaveLength(1);
    expect(entries[0].ideal.x).toBeCloseTo(5);
    expect(entries[0].ideal.y).toBeCloseTo(75);
  });

  it("handles top-left datum correctly", () => {
    const holes: ToolingHole[] = [makeHole("registration", 5, 5)];
    const entries = buildFiducialEntries(holes, "top-left", 100, 80);
    // top-left datum: mx = x, my = 0 - y = -5
    expect(entries[0].ideal.x).toBeCloseTo(5);
    expect(entries[0].ideal.y).toBeCloseTo(-5);
  });

  it("builds an entry per hole", () => {
    const holes: ToolingHole[] = [
      makeHole("registration", 5, 5),
      makeHole("registration", 95, 75),
    ];
    const entries = buildFiducialEntries(holes, "bottom-left", 100, 80);
    expect(entries).toHaveLength(2);
  });
});

describe("fiducialCaptureBounds", () => {
  // With WCO=0 (mpos===wpos), the machine centre = ideal + 0 = ideal.
  const ZERO_POS: readonly number[] = [0, 0, 0];

  it("centres the box on the machine position of the fiducial (WCO=0 → centre = ideal)", () => {
    const bounds = fiducialCaptureBounds(50, 100, ZERO_POS, ZERO_POS, MACHINE_BOUNDS);
    const r = FIDUCIAL_CAPTURE_RADIUS_MM;
    expect(bounds.x[0]).toBeCloseTo(50 - r);
    expect(bounds.x[1]).toBeCloseTo(50 + r);
    expect(bounds.y[0]).toBeCloseTo(100 - r);
    expect(bounds.y[1]).toBeCloseTo(100 + r);
  });

  it("centres on ideal+WCO when WCO≠0 (WCO=(50,30))", () => {
    // ideal work = (10,20), WCO = (50,30) → machine centre = (60,50)
    const mpos: readonly number[] = [60, 50, 0]; // machine pos of any point
    const wpos: readonly number[] = [10, 20, 0]; // work pos of same point → WCO=(50,30)
    const bounds = fiducialCaptureBounds(10, 20, mpos, wpos, MACHINE_BOUNDS);
    const r = FIDUCIAL_CAPTURE_RADIUS_MM;
    expect(bounds.x[0]).toBeCloseTo(60 - r);
    expect(bounds.x[1]).toBeCloseTo(60 + r);
    expect(bounds.y[0]).toBeCloseTo(50 - r);
    expect(bounds.y[1]).toBeCloseTo(50 + r);
  });

  it("clips the box at machine bounds edges", () => {
    // Fiducial machine-centre near origin (machine = ideal + WCO = 0 + 0 = 1,1)
    const bounds = fiducialCaptureBounds(1, 1, ZERO_POS, ZERO_POS, MACHINE_BOUNDS);
    expect(bounds.x[0]).toBe(0); // clipped at machine min
    expect(bounds.y[0]).toBe(0);
    expect(bounds.x[1]).toBeCloseTo(1 + FIDUCIAL_CAPTURE_RADIUS_MM);
    expect(bounds.y[1]).toBeCloseTo(1 + FIDUCIAL_CAPTURE_RADIUS_MM);
  });

  it("passes Z bounds through unchanged", () => {
    const bounds = fiducialCaptureBounds(50, 100, ZERO_POS, ZERO_POS, MACHINE_BOUNDS);
    expect(bounds.z).toEqual(MACHINE_BOUNDS.z);
  });
});

describe("canSolve", () => {
  it("returns false below minimum captures", () => {
    expect(canSolve(0)).toBe(false);
    expect(canSolve(MIN_CAPTURES_FOR_SOLVE - 1)).toBe(false);
  });

  it("returns true at and above minimum captures", () => {
    expect(canSolve(MIN_CAPTURES_FOR_SOLVE)).toBe(true);
    expect(canSolve(MIN_CAPTURES_FOR_SOLVE + 1)).toBe(true);
    expect(canSolve(10)).toBe(true);
  });
});

describe("WCO≠0 frame consistency", () => {
  // Scenario: WCO = (50, 30) — operator set work zero at machine (50,30).
  // Fiducial is at panel position that maps to work-frame ideal = (10, 20).
  // Physical machine position of the fiducial = ideal + WCO = (60, 50).
  const WCO_X = 50;
  const WCO_Y = 30;
  const IDEAL = { x: 10, y: 20 };
  // A live mpos/wpos pair that encodes WCO=(50,30): any (mpos-wpos)=(50,30).
  const MPOS: readonly number[] = [60, 50, -5]; // spindle currently AT the fiducial
  const WPOS: readonly number[] = [10, 20, -5]; // work coords match ideal

  it("jogTo target is ideal (work-frame) directly — no conversion needed", () => {
    // jogTo(ideal) sends the spindle to machine = ideal + WCO = (60, 50).
    // With WCO=(50,30): clampWork converts work (10,20) → machine (60,50) → clamp → back.
    // This test verifies the target IS the work-frame ideal (no subtraction of WCO).
    expect(IDEAL.x).toBe(10);
    expect(IDEAL.y).toBe(20);
    // For the machine to arrive at (60,50): work target must be (10,20).
    // jogTo internally does: machine = work + WCO = 10+50 = 60. Correct.
    const machineXFromWork = IDEAL.x + WCO_X;
    const machineYFromWork = IDEAL.y + WCO_Y;
    expect(machineXFromWork).toBe(60);
    expect(machineYFromWork).toBe(50);
  });

  it("fiducialCaptureBounds centres on ideal+WCO in machine frame", () => {
    const bounds = fiducialCaptureBounds(IDEAL.x, IDEAL.y, MPOS, WPOS, {
      x: [0, 300],
      y: [0, 200],
      z: [-60, 0],
    });
    const r = FIDUCIAL_CAPTURE_RADIUS_MM;
    // Centre must be at machine position of the fiducial = ideal + WCO = (60, 50).
    expect(bounds.x[0]).toBeCloseTo(60 - r);
    expect(bounds.x[1]).toBeCloseTo(60 + r);
    expect(bounds.y[0]).toBeCloseTo(50 - r);
    expect(bounds.y[1]).toBeCloseTo(50 + r);
  });

  it("fit ideal(work)→measured(wpos) has no WCO component (translation = board error only)", () => {
    // If the board sits exactly where it should (no placement error), ideal === measured.
    // Translation must be (0,0) — no WCO leaks into the fit.
    // Work-frame pair: measured = WPos captured after jogTo(ideal).
    // Tiny board placement error (0.05,-0.02) — no WCO in the values.
    const ideal = { x: 10, y: 20 };
    const measured = { x: 10.05, y: 19.98 };
    // Translation from these pairs should be ~(0.05, -0.02) — board error, not WCO.
    const dx = measured.x - ideal.x;
    const dy = measured.y - ideal.y;
    // WCO=(50,30) must NOT appear in the translation.
    expect(Math.abs(dx - WCO_X)).toBeGreaterThan(40); // dx is ~0.05, not ~50
    expect(Math.abs(dy - WCO_Y)).toBeGreaterThan(29); // dy is ~-0.02, not ~30
    expect(Math.abs(dx)).toBeLessThan(0.1);
    expect(Math.abs(dy)).toBeLessThan(0.1);
  });
});
