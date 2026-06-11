import { describe, it, expect } from "vitest";
import { buildExposeSnapshot, DEFAULT_EXPOSURE_S, DEFAULT_PWM } from "./exposeSnapshot";

describe("buildExposeSnapshot", () => {
  it("fills defaults when optional args omitted", () => {
    const snap = buildExposeSnapshot({
      workingDir: "/tmp/wd",
      currentPath: "/tmp/project.cu",
      manifest: null,
    });
    expect(snap.workingDir).toBe("/tmp/wd");
    expect(snap.currentPath).toBe("/tmp/project.cu");
    expect(snap.manifest).toBeNull();
    expect(snap.side).toBe("top");
    expect(snap.mirror).toBe(false);
    expect(snap.invert).toBe(false);
    expect(snap.exposureS).toBe(DEFAULT_EXPOSURE_S);
    expect(snap.pwm).toBe(DEFAULT_PWM);
    expect(snap.placedSizes).toEqual({});
  });

  it("uses provided values over defaults", () => {
    const snap = buildExposeSnapshot({
      workingDir: null,
      currentPath: null,
      manifest: null,
      placedSizes: { "design-1": { w: 40, h: 30 } },
      side: "bottom",
      mirror: true,
      invert: true,
      exposureS: 45,
      pwm: 200,
    });
    expect(snap.side).toBe("bottom");
    expect(snap.mirror).toBe(true);
    expect(snap.invert).toBe(true);
    expect(snap.exposureS).toBe(45);
    expect(snap.pwm).toBe(200);
    expect(snap.placedSizes).toEqual({ "design-1": { w: 40, h: 30 } });
  });

  it("passes through null workingDir and currentPath", () => {
    const snap = buildExposeSnapshot({
      workingDir: null,
      currentPath: null,
      manifest: null,
    });
    expect(snap.workingDir).toBeNull();
    expect(snap.currentPath).toBeNull();
  });

  it("returns a snapshot with the expected shape", () => {
    const snap = buildExposeSnapshot({
      workingDir: "/wd",
      currentPath: "/proj.cu",
      manifest: null,
    });
    // All required fields present
    expect(Object.keys(snap).sort()).toEqual(
      ["currentPath", "exposureS", "invert", "manifest", "mirror", "placedSizes", "pwm", "side", "workingDir"].sort(),
    );
  });
});
