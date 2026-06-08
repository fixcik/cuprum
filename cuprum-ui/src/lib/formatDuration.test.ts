import { describe, expect, it } from "vitest";
import { formatDuration } from "@/lib/formatDuration";

describe("formatDuration", () => {
  it("under a minute: seconds only, no padding", () => {
    expect(formatDuration(0, "мин", "с")).toBe("0 с");
    expect(formatDuration(8, "мин", "с")).toBe("8 с");
    expect(formatDuration(59, "мин", "с")).toBe("59 с");
  });

  it("a minute or more: minutes + zero-padded seconds", () => {
    expect(formatDuration(60, "мин", "с")).toBe("1 мин 00 с");
    expect(formatDuration(128, "мин", "с")).toBe("2 мин 08 с");
    expect(formatDuration(193, "мин", "с")).toBe("3 мин 13 с");
  });

  it("rounds and clamps negatives to zero", () => {
    expect(formatDuration(7.6, "мин", "с")).toBe("8 с");
    expect(formatDuration(-5, "мин", "с")).toBe("0 с");
  });

  it("uses the supplied abbreviations", () => {
    expect(formatDuration(90, "min", "s")).toBe("1 min 30 s");
  });
});
