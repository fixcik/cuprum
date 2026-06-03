import { describe, it, expect } from "vitest";
import { relativeTime } from "@/i18n/relativeTime";

// All cases pass an explicit nowSec so they are deterministic.
const NOW = 1_700_000_000;

describe("relativeTime", () => {
  it("is 'just now' under 45s and for future timestamps", () => {
    expect(relativeTime(NOW, NOW)).toEqual({ key: "history.relative.justNow" });
    expect(relativeTime(NOW - 44, NOW)).toEqual({ key: "history.relative.justNow" });
    expect(relativeTime(NOW + 100, NOW)).toEqual({ key: "history.relative.justNow" });
  });

  it("rounds minutes and caps them at 59", () => {
    expect(relativeTime(NOW - 45, NOW)).toEqual({ key: "history.relative.minutes", params: { n: 1 } });
    expect(relativeTime(NOW - 600, NOW)).toEqual({ key: "history.relative.minutes", params: { n: 10 } });
    expect(relativeTime(NOW - 3599, NOW)).toEqual({ key: "history.relative.minutes", params: { n: 59 } });
  });

  it("floors hours below a day", () => {
    expect(relativeTime(NOW - 7200, NOW)).toEqual({ key: "history.relative.hours", params: { n: 2 } });
  });

  it("uses 'yesterday' between 24h and 48h", () => {
    expect(relativeTime(NOW - 100000, NOW)).toEqual({ key: "history.relative.yesterday" });
  });

  it("floors days beyond 48h", () => {
    expect(relativeTime(NOW - 200000, NOW)).toEqual({ key: "history.relative.days", params: { n: 2 } });
  });
});
