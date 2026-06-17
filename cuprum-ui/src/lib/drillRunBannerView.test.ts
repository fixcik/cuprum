import { describe, it, expect } from "vitest";
import { isBannerVisible, phaseLabel, percent } from "./drillRunBannerView";

describe("isBannerVisible", () => {
  it("visible only when active and phase is a live phase", () => {
    expect(isBannerVisible(true, "running")).toBe(true);
    expect(isBannerVisible(true, "awaitingToolChange")).toBe(true);
    expect(isBannerVisible(false, "running")).toBe(false);
    expect(isBannerVisible(true, "done")).toBe(false);
    expect(isBannerVisible(true, "idle")).toBe(false);
  });
});

describe("phaseLabel", () => {
  it("maps phases to i18n keys, pulsing only while running", () => {
    expect(phaseLabel("running")).toEqual({ key: "operations.banner.running", pulsing: true });
    expect(phaseLabel("paused")).toEqual({ key: "operations.banner.paused", pulsing: false });
    expect(phaseLabel("pausing")).toEqual({ key: "operations.banner.paused", pulsing: false });
    expect(phaseLabel("awaitingToolChange")).toEqual({
      key: "operations.banner.toolChange",
      pulsing: false,
    });
    expect(phaseLabel("stopping")).toEqual({ key: "operations.banner.stopping", pulsing: false });
  });
  it("falls back to running label for unknown phases", () => {
    expect(phaseLabel("weird")).toEqual({ key: "operations.banner.running", pulsing: true });
  });
});

describe("percent", () => {
  it("rounds done/total, 0 when total is 0", () => {
    expect(percent(52, 84)).toBe(62);
    expect(percent(0, 84)).toBe(0);
    expect(percent(5, 0)).toBe(0);
    expect(percent(84, 84)).toBe(100);
  });
});
