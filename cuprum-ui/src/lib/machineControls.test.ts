import { describe, expect, it } from "vitest";
import { canMove } from "@/lib/machineControls";

describe("canMove", () => {
  it("allows motion only when connected and idle or jogging", () => {
    expect(canMove("idle", true)).toBe(true);
    expect(canMove("jog", true)).toBe(true);
  });
  it("blocks motion when alarmed, running, held or disconnected", () => {
    expect(canMove("alarm", true)).toBe(false);
    expect(canMove("run", true)).toBe(false);
    expect(canMove("hold", true)).toBe(false);
    expect(canMove("idle", false)).toBe(false);
    expect(canMove("unknown", true)).toBe(false);
  });
});
