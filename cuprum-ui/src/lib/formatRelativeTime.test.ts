import { describe, it, expect, vi, afterEach } from "vitest";
import { formatRelativeTime } from "@/lib/formatRelativeTime";

const NOW_SEC = 1_700_000_000;
const enRtf = (n: number, unit: Intl.RelativeTimeFormatUnit) =>
  new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(n, unit);

afterEach(() => vi.restoreAllMocks());

function freezeNow() {
  vi.spyOn(Date, "now").mockReturnValue(NOW_SEC * 1000);
}

describe("formatRelativeTime", () => {
  it("uses the zero-second form under a minute", () => {
    freezeNow();
    expect(formatRelativeTime(NOW_SEC - 30, "en")).toBe(enRtf(0, "second"));
  });

  it("buckets into minutes, hours and days with past offsets", () => {
    freezeNow();
    expect(formatRelativeTime(NOW_SEC - 5 * 60, "en")).toBe(enRtf(-5, "minute"));
    expect(formatRelativeTime(NOW_SEC - 2 * 3600, "en")).toBe(enRtf(-2, "hour"));
    expect(formatRelativeTime(NOW_SEC - 3 * 86400, "en")).toBe(enRtf(-3, "day"));
  });

  it("falls back to a locale date string beyond a week", () => {
    freezeNow();
    const tsSec = NOW_SEC - 10 * 86400;
    expect(formatRelativeTime(tsSec, "en")).toBe(new Date(tsSec * 1000).toLocaleDateString("en"));
  });
});
