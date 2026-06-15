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
  it("centres the box on the ideal position within machine bounds", () => {
    const bounds = fiducialCaptureBounds(50, 100, MACHINE_BOUNDS);
    const r = FIDUCIAL_CAPTURE_RADIUS_MM;
    expect(bounds.x[0]).toBeCloseTo(50 - r);
    expect(bounds.x[1]).toBeCloseTo(50 + r);
    expect(bounds.y[0]).toBeCloseTo(100 - r);
    expect(bounds.y[1]).toBeCloseTo(100 + r);
  });

  it("clips the box at machine bounds edges", () => {
    // Fiducial very close to the machine origin (0,0)
    const bounds = fiducialCaptureBounds(1, 1, MACHINE_BOUNDS);
    expect(bounds.x[0]).toBe(0); // clipped at machine min
    expect(bounds.y[0]).toBe(0);
    expect(bounds.x[1]).toBeCloseTo(1 + FIDUCIAL_CAPTURE_RADIUS_MM);
    expect(bounds.y[1]).toBeCloseTo(1 + FIDUCIAL_CAPTURE_RADIUS_MM);
  });

  it("passes Z bounds through unchanged", () => {
    const bounds = fiducialCaptureBounds(50, 100, MACHINE_BOUNDS);
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
