import { describe, it, expect } from "vitest";
import { formatDuration, dayBucket } from "./runHistoryFormat";

const L = { h: "ч", m: "м", s: "с" };

describe("formatDuration", () => {
  it("seconds only under a minute", () => {
    expect(formatDuration(45, L)).toBe("45 с");
  });
  it("minutes and seconds", () => {
    expect(formatDuration(74, L)).toBe("1 м 14 с");
  });
  it("drops zero seconds", () => {
    expect(formatDuration(120, L)).toBe("2 м");
  });
  it("hours and minutes at/above an hour (fixes the 9173м bug)", () => {
    expect(formatDuration(3 * 3600 + 25 * 60, L)).toBe("3 ч 25 м");
  });
  it("drops zero minutes for whole hours", () => {
    expect(formatDuration(2 * 3600, L)).toBe("2 ч");
  });
  it("never renders raw inflated minutes", () => {
    expect(formatDuration(5 * 3600 + 2 * 60 + 3, L)).toBe("5 ч 2 м");
  });
});

describe("dayBucket", () => {
  const now = new Date(2026, 5, 17, 12, 0, 0).getTime() / 1000;
  it("today → n=0", () => {
    const ts = new Date(2026, 5, 17, 3, 0, 0).getTime() / 1000;
    expect(dayBucket(ts, now)).toEqual({ days: 0 });
  });
  it("calendar yesterday counts as 1 even if <24h", () => {
    const ts = new Date(2026, 5, 16, 23, 0, 0).getTime() / 1000;
    expect(dayBucket(ts, now)).toEqual({ days: 1 });
  });
  it("six calendar days ago", () => {
    const ts = new Date(2026, 5, 11, 8, 0, 0).getTime() / 1000;
    expect(dayBucket(ts, now)).toEqual({ days: 6 });
  });
});
