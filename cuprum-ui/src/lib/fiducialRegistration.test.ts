import { describe, it, expect } from "vitest";
import {
  classifyRms,
  buildFiducialEntries,
  captureBoundsAroundMachine,
  canSolve,
  pointResiduals,
  undoRegistration,
  FIDUCIAL_CAPTURE_RADIUS_MM,
  MIN_CAPTURES_FOR_SOLVE,
  RMS_WARN_MM,
  RMS_ERROR_MM,
} from "@/lib/fiducialRegistration";

const makePoint = (x_mm: number, y_mm: number) => ({ x_mm, y_mm });

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

describe("buildFiducialEntries", () => {
  // Panel 100×80 mm, datum bottom-left: datum XY = (panelX, panelH - panelY)
  it("converts panel coords to datum-relative coords with bottom-left datum", () => {
    const entries = buildFiducialEntries([makePoint(5, 5)], "bottom-left", 100, 80);
    // bottom-left datum: mx = x, my = H - y = 80 - 5 = 75
    expect(entries).toHaveLength(1);
    expect(entries[0].ideal.x).toBeCloseTo(5);
    expect(entries[0].ideal.y).toBeCloseTo(75);
  });

  it("handles top-left datum correctly", () => {
    const entries = buildFiducialEntries([makePoint(5, 5)], "top-left", 100, 80);
    // top-left datum: mx = x, my = 0 - y = -5
    expect(entries[0].ideal.x).toBeCloseTo(5);
    expect(entries[0].ideal.y).toBeCloseTo(-5);
  });

  it("builds an entry per point", () => {
    const entries = buildFiducialEntries(
      [makePoint(5, 5), makePoint(95, 75)],
      "bottom-left",
      100,
      80,
    );
    expect(entries).toHaveLength(2);
  });
});

describe("captureBoundsAroundMachine", () => {
  it("centres the ±r box on the given machine position", () => {
    const bounds = captureBoundsAroundMachine(50, 100, MACHINE_BOUNDS);
    const r = FIDUCIAL_CAPTURE_RADIUS_MM;
    expect(bounds.x[0]).toBeCloseTo(50 - r);
    expect(bounds.x[1]).toBeCloseTo(50 + r);
    expect(bounds.y[0]).toBeCloseTo(100 - r);
    expect(bounds.y[1]).toBeCloseTo(100 + r);
  });

  it("clips the box at machine bounds edges", () => {
    const bounds = captureBoundsAroundMachine(1, 1, MACHINE_BOUNDS);
    expect(bounds.x[0]).toBe(0); // clipped at machine min
    expect(bounds.y[0]).toBe(0);
    expect(bounds.x[1]).toBeCloseTo(1 + FIDUCIAL_CAPTURE_RADIUS_MM);
    expect(bounds.y[1]).toBeCloseTo(1 + FIDUCIAL_CAPTURE_RADIUS_MM);
  });

  it("passes Z bounds through unchanged", () => {
    const bounds = captureBoundsAroundMachine(50, 100, MACHINE_BOUNDS);
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

describe("pointResiduals", () => {
  // Model: measured = workOrigin + s·R(θ)·ideal (see solve_machine_frame).
  const predict = (
    ideal: { x: number; y: number },
    s: number,
    angleRad: number,
    origin: { x: number; y: number },
  ) => {
    const c = Math.cos(angleRad);
    const n = Math.sin(angleRad);
    return {
      x: origin.x + s * (c * ideal.x - n * ideal.y),
      y: origin.y + s * (n * ideal.x + c * ideal.y),
    };
  };

  it("is zero for points lying exactly on the solved transform", () => {
    const origin = { x: 120, y: 80 };
    const reg = { scale: 1.0, angleRad: 0.02 };
    const ideals = [
      { x: 5, y: 75 },
      { x: 95, y: 75 },
      { x: 50, y: 5 },
    ];
    const fids = ideals.map((ideal) => ({
      ideal,
      measured: predict(ideal, reg.scale, reg.angleRad, origin),
    }));
    const res = pointResiduals(fids, reg, origin);
    expect(res).toHaveLength(3);
    for (const r of res) expect(r).toBeCloseTo(0, 9);
  });

  it("reports the offset of a perturbed point and null for uncaptured", () => {
    const origin = { x: 10, y: 20 };
    const reg = { scale: 1.0, angleRad: 0 };
    const fids = [
      { ideal: { x: 0, y: 0 }, measured: { x: 10.03, y: 19.96 } }, // off by (0.03, -0.04)
      { ideal: { x: 100, y: 0 }, measured: { x: 110, y: 20 } }, // exact
      { ideal: { x: 0, y: 80 }, measured: null }, // not captured
    ];
    const res = pointResiduals(fids, reg, origin);
    expect(res[0]).toBeCloseTo(0.05); // hypot(0.03, 0.04)
    expect(res[1]).toBeCloseTo(0);
    expect(res[2]).toBeNull();
  });

  it("accounts for rotation and scale (residual is not just measured − ideal − origin)", () => {
    const origin = { x: 0, y: 0 };
    const reg = { scale: 1.001, angleRad: Math.PI / 90 }; // 2°
    const ideal = { x: 100, y: 0 };
    const measured = predict(ideal, reg.scale, reg.angleRad, origin);
    // With rotation applied the residual is ~0 …
    expect(pointResiduals([{ ideal, measured }], reg, origin)[0]).toBeCloseTo(0, 9);
    // … while a naive translation-only model would see several mm of error.
    const naive = Math.hypot(measured.x - ideal.x, measured.y - ideal.y);
    expect(naive).toBeGreaterThan(1);
  });

  it("RMS of per-point residuals matches the aggregate definition", () => {
    const origin = { x: 50, y: 50 };
    const reg = { scale: 1.0, angleRad: 0 };
    const fids = [
      { ideal: { x: 0, y: 0 }, measured: { x: 50.1, y: 50 } }, // residual 0.1
      { ideal: { x: 10, y: 0 }, measured: { x: 60, y: 50.1 } }, // residual 0.1
    ];
    const res = pointResiduals(fids, reg, origin) as number[];
    const rms = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length);
    expect(rms).toBeCloseTo(0.1);
  });
});

describe("undoRegistration", () => {
  it("inverts the emitter's forward transform (work = s\u00b7R\u00b7ideal)", () => {
    const reg = { scale: 1.002, angleRad: (1.3 * Math.PI) / 180 };
    const ideal = { x: 25.5, y: 50 };
    const cos = Math.cos(reg.angleRad);
    const sin = Math.sin(reg.angleRad);
    const work = {
      x: reg.scale * (cos * ideal.x - sin * ideal.y),
      y: reg.scale * (sin * ideal.x + cos * ideal.y),
    };
    const back = undoRegistration(work, reg);
    expect(back.x).toBeCloseTo(ideal.x, 9);
    expect(back.y).toBeCloseTo(ideal.y, 9);
  });

  it("is the identity for the identity registration", () => {
    const back = undoRegistration({ x: 12.3, y: -4.5 }, { scale: 1, angleRad: 0 });
    expect(back).toEqual({ x: 12.3, y: -4.5 });
  });
});

