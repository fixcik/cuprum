import { describe, it, expect } from "vitest";
import { buildExposeRequest } from "@/lib/exposeSnapshot";
import type { ExposeSnapshot } from "@/lib/api";

const BASE_SNAP: ExposeSnapshot = {
  workingDir: "/tmp/project.workdir",
  currentPath: "/tmp/project.cuprum",
  manifest: {
    schema_version: 1,
    name: "Test board",
    description: "",
    designs: [
      {
        id: "design-a",
        source_name: "boardA",
        gerbers: [
          { path: "design-a/top_copper.gbr", layer_type: "topCopper" },
          { path: "design-a/bottom_copper.gbr", layer_type: "bottomCopper" },
          { path: "design-a/edge_cuts.gbr", layer_type: "edgeCuts" },
        ],
      },
      {
        id: "design-b",
        source_name: "boardB",
        gerbers: [
          { path: "design-b/top_copper.gbr", layer_type: "topCopper" },
        ],
      },
    ],
    exposure: null,
    layer_colors: {},
    stackup: null,
    panel: {
      schema_version: 1,
      width_mm: 100,
      height_mm: 80,
      origin_x_mm: 0,
      origin_y_mm: 0,
      instances: [
        { id: "inst-1", design_id: "design-a", x_mm: 5, y_mm: 5, rotation_deg: 0 },
        { id: "inst-2", design_id: "design-a", x_mm: 55, y_mm: 5, rotation_deg: 0 },
      ],
      tooling_holes: [],
      keep_out_zones: [],
      drill_class_overrides: {},
    },
  },
  placedSizes: { "design-a": { w: 40, h: 30 } },
  side: "top",
  mirror: false,
  invert: false,
  exposureS: 60,
  pwm: 255,
};

describe("buildExposeRequest", () => {
  it("maps snapshot to ExposeRunRequest with correct camelCase fields", () => {
    const req = buildExposeRequest(BASE_SNAP, {
      side: "top",
      mirror: false,
      invert: true,
      exposureS: 45,
      pwm: 200,
      runUid: "test-uid-123",
    });

    expect(req).not.toBeNull();
    expect(req!.workingDir).toBe("/tmp/project.workdir");
    expect(req!.runUid).toBe("test-uid-123");
    expect(req!.exposureS).toBe(45);
    expect(req!.pwm).toBe(200);
    expect(req!.invert).toBe(true);
    expect(req!.side).toBe("top");

    // Panel dims
    expect(req!.panel.widthMm).toBe(100);
    expect(req!.panel.heightMm).toBe(80);

    // Instances mapped to camelCase
    expect(req!.panel.instances).toHaveLength(2);
    expect(req!.panel.instances[0]).toEqual({
      designId: "design-a",
      xMm: 5,
      yMm: 5,
      rotationDeg: 0,
    });

    // Only design-a is placed (design-b has no instances)
    expect(req!.designs).toHaveLength(1);
    expect(req!.designs[0].id).toBe("design-a");

    // Gerbers use layerType (camelCase)
    const gerbers = req!.designs[0].gerbers;
    expect(gerbers.find((g) => g.layerType === "topCopper")).toBeTruthy();
    expect(gerbers.find((g) => g.layerType === "bottomCopper")).toBeTruthy();
  });

  it("returns null when workingDir is null", () => {
    const snap = { ...BASE_SNAP, workingDir: null };
    expect(buildExposeRequest(snap, { side: "top", mirror: false, invert: false, exposureS: 60, pwm: 255, runUid: "x" })).toBeNull();
  });

  it("returns null when manifest is null", () => {
    const snap = { ...BASE_SNAP, manifest: null };
    expect(buildExposeRequest(snap, { side: "top", mirror: false, invert: false, exposureS: 60, pwm: 255, runUid: "x" })).toBeNull();
  });

  it("returns null when panel is null", () => {
    const snap = { ...BASE_SNAP, manifest: { ...BASE_SNAP.manifest!, panel: null } };
    expect(buildExposeRequest(snap, { side: "top", mirror: false, invert: false, exposureS: 60, pwm: 255, runUid: "x" })).toBeNull();
  });

  it("returns null when no designs are placed", () => {
    const snap: ExposeSnapshot = {
      ...BASE_SNAP,
      manifest: {
        ...BASE_SNAP.manifest!,
        panel: { ...BASE_SNAP.manifest!.panel!, instances: [] },
      },
    };
    expect(buildExposeRequest(snap, { side: "top", mirror: false, invert: false, exposureS: 60, pwm: 255, runUid: "x" })).toBeNull();
  });

  it("handles bottom side correctly", () => {
    const req = buildExposeRequest(BASE_SNAP, {
      side: "bottom",
      mirror: true,
      invert: false,
      exposureS: 30,
      pwm: 128,
      runUid: "uid-bottom",
    });
    expect(req!.side).toBe("bottom");
    expect(req!.mirror).toBe(true);
    expect(req!.exposureS).toBe(30);
    expect(req!.pwm).toBe(128);
  });
});
