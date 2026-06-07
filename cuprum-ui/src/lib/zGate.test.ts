import { describe, expect, it } from "vitest";
import { checkZGate } from "@/lib/zGate";

describe("checkZGate", () => {
  it("valid when depth + tool-change retract fit the travel", () => {
    expect(checkZGate({ safeZMm: 5, toolChangeZMm: 20, depthMm: 1.9, envZMm: 45 })).toEqual({
      valid: true,
    });
  });
  it("blocks when depth alone exceeds travel", () => {
    const r = checkZGate({ safeZMm: 5, toolChangeZMm: 20, depthMm: 50, envZMm: 45 });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reasons).toContain("depth");
  });
  it("blocks when the tool-change retract exceeds travel", () => {
    const r = checkZGate({ safeZMm: 5, toolChangeZMm: 50, depthMm: 1, envZMm: 45 });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reasons).toContain("toolchange");
  });
  it("blocks when depth + tool-change span exceeds travel", () => {
    const r = checkZGate({ safeZMm: 5, toolChangeZMm: 40, depthMm: 10, envZMm: 45 });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.reasons).toContain("span");
  });
});
