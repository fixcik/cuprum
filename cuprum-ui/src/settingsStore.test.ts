import { describe, it, expect, beforeEach } from "vitest";
import { useSettings } from "@/settingsStore";
import { DEFAULT_PROFILE } from "@/lib/capabilityProfile";
import { DEFAULT_NEST } from "@/lib/nest";
import type { PanelPreset } from "@/lib/panel";

// Snapshot the initial state (incl. action fns) and restore it before each test
// so the module-singleton store does not leak between cases.
const initial = useSettings.getState();
beforeEach(() => useSettings.setState(initial, true));

const preset = (id: string, widthMm = 100): PanelPreset => ({
  id,
  name: id,
  widthMm,
  heightMm: 100,
  stackup: { copper_weight_oz: 1, substrate_thickness_mm: 1.6, double_sided: true },
});

describe("settingsStore profile", () => {
  it("patches individual profile fields, leaving the rest at defaults", () => {
    useSettings.getState().setProfile({ minTraceMm: 0.2 });
    const p = useSettings.getState().profile;
    expect(p.minTraceMm).toBe(0.2);
    expect(p.minDrillMm).toBe(DEFAULT_PROFILE.minDrillMm);
  });

  it("resets the profile back to defaults", () => {
    useSettings.getState().setProfile({ minTraceMm: 0.99 });
    useSettings.getState().resetProfile();
    expect(useSettings.getState().profile).toEqual(DEFAULT_PROFILE);
  });
});

describe("settingsStore language & units", () => {
  it("sets language and units", () => {
    useSettings.getState().setLanguage("ru");
    useSettings.getState().setUnits("imperial");
    expect(useSettings.getState().language).toBe("ru");
    expect(useSettings.getState().units).toBe("imperial");
  });
});

describe("settingsStore panel presets", () => {
  it("adds a new preset", () => {
    useSettings.getState().addPanelPreset(preset("a"));
    expect(useSettings.getState().panelPresets.map((p) => p.id)).toEqual(["a"]);
  });

  it("upserts a preset with an existing id in place", () => {
    useSettings.getState().addPanelPreset(preset("a", 100));
    useSettings.getState().addPanelPreset(preset("b", 100));
    useSettings.getState().addPanelPreset(preset("a", 222));
    const presets = useSettings.getState().panelPresets;
    expect(presets.map((p) => p.id)).toEqual(["a", "b"]); // no duplicate, order kept
    expect(presets.find((p) => p.id === "a")!.widthMm).toBe(222); // replaced in place
  });

  it("removes a preset by id", () => {
    useSettings.getState().addPanelPreset(preset("a"));
    useSettings.getState().addPanelPreset(preset("b"));
    useSettings.getState().removePanelPreset("a");
    expect(useSettings.getState().panelPresets.map((p) => p.id)).toEqual(["b"]);
  });
});

describe("settingsStore nest", () => {
  it("patches nesting fields, leaving the rest at defaults", () => {
    useSettings.getState().setNest({ enabled: true, copies: 12 });
    const n = useSettings.getState().nest;
    expect(n.enabled).toBe(true);
    expect(n.copies).toBe(12);
    expect(n.marginMm).toBe(DEFAULT_NEST.marginMm);
  });
});

describe("panelInspector", () => {
  it("patches inspector UI state in place", () => {
    useSettings.getState().setPanelInspector({ width: 400 });
    expect(useSettings.getState().panelInspector.width).toBe(400);
    useSettings.getState().setPanelInspector({ collapsed: true });
    expect(useSettings.getState().panelInspector).toMatchObject({ width: 400, collapsed: true });
  });
});
