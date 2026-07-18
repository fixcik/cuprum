import { describe, expect, it } from "vitest";
import {
  ALIGN_SNAP_RADIUS_MM,
  PROBEABLE_MIN_HOLE_DIAMETER_MM,
  alignmentPointOrdinals,
  cornerOfPoint,
  effectiveAlignmentPoints,
  isProbeable,
  nextAlignmentPointId,
  panelCornerPoints,
  snapAlignmentPoint,
  type HoleCandidate,
} from "@/lib/alignmentPoints";
import type { AlignmentPoint, ToolingHole } from "@/lib/api";

const hole = (xMm: number, yMm: number, diameterMm: number): HoleCandidate => ({ xMm, yMm, diameterMm });

const th = (id: string, x: number, y: number, d: number, role: ToolingHole["role"]): ToolingHole => ({
  id,
  x_mm: x,
  y_mm: y,
  diameter_mm: d,
  role,
});

describe("snapAlignmentPoint", () => {
  it("returns the raw click as a free point when no hole is in range", () => {
    const r = snapAlignmentPoint({ x: 10, y: 10 }, [hole(20, 20, 3)]);
    expect(r).toEqual({ x: 10, y: 10 });
    expect(r.holeDiameterMm).toBeUndefined();
  });

  it("snaps to a hole centre within the 2.5 mm radius and inherits its diameter", () => {
    const r = snapAlignmentPoint({ x: 11, y: 10 }, [hole(12.5, 10, 3)]);
    expect(r).toEqual({ x: 12.5, y: 10, holeDiameterMm: 3 });
  });

  it("snaps exactly at the threshold distance (inclusive)", () => {
    const r = snapAlignmentPoint({ x: 0, y: 0 }, [hole(ALIGN_SNAP_RADIUS_MM, 0, 2)]);
    expect(r.holeDiameterMm).toBe(2);
  });

  it("does not snap just beyond the threshold", () => {
    const r = snapAlignmentPoint({ x: 0, y: 0 }, [hole(ALIGN_SNAP_RADIUS_MM + 0.001, 0, 2)]);
    expect(r.holeDiameterMm).toBeUndefined();
  });

  it("picks the nearest of several holes in range", () => {
    const r = snapAlignmentPoint({ x: 10, y: 10 }, [hole(11.5, 10, 4), hole(10.5, 10, 1.5)]);
    expect(r).toEqual({ x: 10.5, y: 10, holeDiameterMm: 1.5 });
  });

  it("honours a custom radius", () => {
    expect(snapAlignmentPoint({ x: 0, y: 0 }, [hole(4, 0, 3)], 5).holeDiameterMm).toBe(3);
    expect(snapAlignmentPoint({ x: 0, y: 0 }, [hole(4, 0, 3)], 1).holeDiameterMm).toBeUndefined();
  });
});

describe("isProbeable", () => {
  it("is false for free points (no hole)", () => {
    expect(isProbeable({ hole_diameter_mm: null })).toBe(false);
    expect(isProbeable({})).toBe(false);
  });

  it("is true at and above the threshold, false below", () => {
    expect(isProbeable({ hole_diameter_mm: PROBEABLE_MIN_HOLE_DIAMETER_MM })).toBe(true);
    expect(isProbeable({ hole_diameter_mm: 3 })).toBe(true);
    expect(isProbeable({ hole_diameter_mm: 1.9 })).toBe(false);
  });
});

describe("effectiveAlignmentPoints", () => {
  it("merges registration holes (first) with explicit points, mirroring Rust", () => {
    const holes = [th("th-1", 5, 5, 3, "registration"), th("th-2", 90, 5, 3, "flip"), th("th-3", 5, 90, 3, "unused")];
    const explicit: AlignmentPoint[] = [{ id: "ap-1", x_mm: 50, y_mm: 50, hole_diameter_mm: null }];
    const eff = effectiveAlignmentPoints(holes, explicit);
    expect(eff.map((e) => e.point.id)).toEqual(["th-1", "ap-1"]);
    expect(eff[0].source).toBe("registration");
    expect(eff[0].point.hole_diameter_mm).toBe(3);
    expect(eff[1].source).toBe("user");
  });

  it("is empty when there are no registration holes and no explicit points", () => {
    expect(effectiveAlignmentPoints([th("th-1", 0, 0, 3, "flip")], [])).toEqual([]);
  });
});

describe("alignmentPointOrdinals", () => {
  it("numbers registration and user points independently, in list order", () => {
    const holes = [th("th-1", 5, 5, 3, "registration"), th("th-2", 5, 90, 3, "registration")];
    const explicit: AlignmentPoint[] = [
      { id: "ap-7", x_mm: 20, y_mm: 20, hole_diameter_mm: null },
      { id: "ap-2", x_mm: 40, y_mm: 40, hole_diameter_mm: null },
    ];
    const ord = alignmentPointOrdinals(effectiveAlignmentPoints(holes, explicit));
    expect(ord.get("th-1")).toBe(1);
    expect(ord.get("th-2")).toBe(2);
    // User points restart from 1 regardless of their ids.
    expect(ord.get("ap-7")).toBe(1);
    expect(ord.get("ap-2")).toBe(2);
  });

  it("skips synthetic corner points (they are named, not numbered)", () => {
    const explicit: AlignmentPoint[] = [{ id: "ap-1", x_mm: 20, y_mm: 20, hole_diameter_mm: null }];
    const pts = [...effectiveAlignmentPoints([], explicit), ...panelCornerPoints(60, 100)];
    const ord = alignmentPointOrdinals(pts);
    expect(ord.get("ap-1")).toBe(1);
    expect(ord.get("corner:bottom-left")).toBeUndefined();
    expect(ord.size).toBe(1);
  });
});

describe("panelCornerPoints", () => {
  it("yields the four panel corners in panel space (Y-down, origin top-left)", () => {
    const pts = panelCornerPoints(60, 100);
    const byCorner = new Map(pts.map((p) => [cornerOfPoint(p), p.point]));
    expect(pts).toHaveLength(4);
    expect(pts.every((p) => p.source === "corner")).toBe(true);
    expect(byCorner.get("top-left")).toMatchObject({ x_mm: 0, y_mm: 0 });
    expect(byCorner.get("top-right")).toMatchObject({ x_mm: 60, y_mm: 0 });
    expect(byCorner.get("bottom-left")).toMatchObject({ x_mm: 0, y_mm: 100 });
    expect(byCorner.get("bottom-right")).toMatchObject({ x_mm: 60, y_mm: 100 });
  });

  it("corner points carry no hole and are not probeable", () => {
    for (const p of panelCornerPoints(60, 100)) expect(isProbeable(p.point)).toBe(false);
  });

  it("cornerOfPoint is null for real points", () => {
    const real = effectiveAlignmentPoints([], [{ id: "ap-1", x_mm: 1, y_mm: 2 }]);
    expect(cornerOfPoint(real[0])).toBeNull();
  });
});

describe("nextAlignmentPointId", () => {
  it("starts at ap-1 and stays stable across deletions", () => {
    expect(nextAlignmentPointId([])).toBe("ap-1");
    expect(
      nextAlignmentPointId([
        { id: "ap-1", x_mm: 0, y_mm: 0 },
        { id: "ap-3", x_mm: 1, y_mm: 1 },
      ]),
    ).toBe("ap-4");
  });

  it("ignores malformed ids", () => {
    expect(nextAlignmentPointId([{ id: "weird", x_mm: 0, y_mm: 0 }])).toBe("ap-1");
  });
});
