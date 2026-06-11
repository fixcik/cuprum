import { describe, expect, it } from "vitest";
import { canMove, canSetZero } from "@/lib/machineControls";

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

describe("canSetZero", () => {
  it("allows binding a zero only when connected and idle", () => {
    expect(canSetZero("idle", true)).toBe(true);
  });
  it("blocks while jogging — jog is motion, a zero set mid-jog would be stale", () => {
    expect(canSetZero("jog", true)).toBe(false);
  });
  it("blocks while running, held, alarmed or disconnected", () => {
    expect(canSetZero("run", true)).toBe(false);
    expect(canSetZero("hold", true)).toBe(false);
    expect(canSetZero("alarm", true)).toBe(false);
    expect(canSetZero("home", true)).toBe(false);
    expect(canSetZero("idle", false)).toBe(false);
    expect(canSetZero("unknown", true)).toBe(false);
  });
});
