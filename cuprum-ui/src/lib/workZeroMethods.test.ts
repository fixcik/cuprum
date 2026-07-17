import { describe, expect, it } from "vitest";
import { cardState, methodAvailability } from "./workZeroMethods";

describe("methodAvailability", () => {
  const base = { connected: true, pointCount: 0, probeReady: false, probeableCount: 0 };

  it("blocks all three methods while disconnected", () => {
    const a = methodAvailability({ ...base, connected: false, pointCount: 5, probeReady: true, probeableCount: 3, probeWizardReady: true });
    expect(a[1]).toEqual({ available: false, reason: "disconnected" });
    expect(a[2]).toEqual({ available: false, reason: "disconnected" });
    expect(a[3]).toEqual({ available: false, reason: "disconnected" });
  });

  it("method 1 is always available once connected", () => {
    expect(methodAvailability(base)[1]).toEqual({ available: true, reason: null });
  });

  it("method 2 needs at least 2 alignment points", () => {
    expect(methodAvailability({ ...base, pointCount: 0 })[2].reason).toBe("noPoints");
    expect(methodAvailability({ ...base, pointCount: 1 })[2].reason).toBe("noPoints");
  });

  it("method 2 opens as soon as 2+ points exist (wizard has shipped)", () => {
    expect(methodAvailability({ ...base, pointCount: 2 })[2]).toEqual({
      available: true,
      reason: null,
    });
    expect(methodAvailability({ ...base, pointCount: 5 })[2]).toEqual({
      available: true,
      reason: null,
    });
  });

  it("method 3 reports probe-not-configured first", () => {
    expect(methodAvailability({ ...base, probeableCount: 5 })[3].reason).toBe("probeNotConfigured");
  });

  it("method 3 with a probe but too few probeable holes", () => {
    expect(methodAvailability({ ...base, probeReady: true, probeableCount: 1 })[3].reason).toBe(
      "noProbeableHoles",
    );
  });

  it("method 3 with probe + holes is pending until its wizard ships", () => {
    expect(methodAvailability({ ...base, probeReady: true, probeableCount: 2 })[3].reason).toBe(
      "wizardPending",
    );
    expect(
      methodAvailability({ ...base, probeReady: true, probeableCount: 2, probeWizardReady: true })[3],
    ).toEqual({ available: true, reason: null });
  });
});

describe("cardState", () => {
  it("disconnected wins over everything", () => {
    const s = cardState({
      connected: false,
      workZeroSet: true,
      binding: { method: 3, rmsMm: 0.03, angleDeg: 1.18 },
      xyOverrun: true,
    });
    expect(s.kind).toBe("disconnected");
    expect(s.overrun).toBe(false);
  });

  it("unset when connected but no zero bound", () => {
    const s = cardState({ connected: true, workZeroSet: false, binding: null, xyOverrun: false });
    expect(s).toMatchObject({ kind: "unset", method: null, quality: "none" });
  });

  it("method 1 bind: set, no quality estimate", () => {
    const s = cardState({
      connected: true,
      workZeroSet: true,
      binding: { method: 1, rmsMm: null, angleDeg: null },
      xyOverrun: false,
    });
    expect(s).toMatchObject({ kind: "set", method: 1, quality: "none", rmsMm: null, angleDeg: null });
  });

  it("bound without metadata falls back to method 1", () => {
    const s = cardState({ connected: true, workZeroSet: true, binding: null, xyOverrun: false });
    expect(s).toMatchObject({ kind: "set", method: 1, quality: "none" });
  });

  it("method 3 with good RMS", () => {
    const s = cardState({
      connected: true,
      workZeroSet: true,
      binding: { method: 3, rmsMm: 0.03, angleDeg: 1.18 },
      xyOverrun: false,
    });
    expect(s).toMatchObject({ kind: "set", method: 3, quality: "good", rmsMm: 0.03, angleDeg: 1.18 });
  });

  it("method 2 with warn RMS", () => {
    const s = cardState({
      connected: true,
      workZeroSet: true,
      binding: { method: 2, rmsMm: 0.14, angleDeg: 1.18 },
      xyOverrun: false,
    });
    expect(s.quality).toBe("warn");
  });

  it("method 2 with bad RMS + overrun", () => {
    const s = cardState({
      connected: true,
      workZeroSet: true,
      binding: { method: 2, rmsMm: 0.62, angleDeg: 1.18 },
      xyOverrun: true,
    });
    expect(s.quality).toBe("bad");
    expect(s.overrun).toBe(true);
  });
});
