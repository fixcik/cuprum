import { describe, it, expect } from "vitest";
import { resolveJogBounds } from "@/lib/jogBounds";

describe("resolveJogBounds", () => {
  it("defaults to the work envelope when no bounds are supplied", () => {
    expect(resolveJogBounds({ x: 200, y: 200, z: 50 })).toEqual({
      x: [0, 200],
      y: [0, 200],
      z: [-50, 0],
    });
  });

  it("returns explicit bounds verbatim when supplied", () => {
    const bounds = { x: [0, 300] as [number, number], y: [0, 180] as [number, number], z: [-40, 0] as [number, number] };
    expect(resolveJogBounds({ x: 200, y: 200, z: 50 }, bounds)).toEqual(bounds);
  });

  it("treats null firmware travel as 'not read yet' → bounds unchanged", () => {
    expect(resolveJogBounds({ x: 300, y: 180, z: 45 }, undefined, null)).toEqual({
      x: [0, 300],
      y: [0, 180],
      z: [-45, 0],
    });
  });

  it("clamps the upper X/Y edge and Z floor to firmware travel when the profile is larger", () => {
    expect(resolveJogBounds({ x: 300, y: 180, z: 45 }, undefined, [290, 175, 40])).toEqual({
      x: [0, 290],
      y: [0, 175],
      z: [-40, 0],
    });
  });

  it("keeps the profile bound when it is smaller than firmware travel", () => {
    expect(resolveJogBounds({ x: 300, y: 180, z: 45 }, undefined, [320, 200, 60])).toEqual({
      x: [0, 300],
      y: [0, 180],
      z: [-45, 0],
    });
  });

  it("intersects per-edge independently (min of profile and firmware per axis)", () => {
    // X firmware-limited, Y profile-limited, Z firmware-limited.
    expect(resolveJogBounds({ x: 300, y: 180, z: 45 }, undefined, [280, 200, 30])).toEqual({
      x: [0, 280],
      y: [0, 180],
      z: [-30, 0],
    });
  });

  it("intersects explicit machine-frame bounds, not only the default envelope", () => {
    const bounds = { x: [0, 250] as [number, number], y: [0, 150] as [number, number], z: [-40, 0] as [number, number] };
    expect(resolveJogBounds({ x: 300, y: 180, z: 45 }, bounds, [240, 160, 35])).toEqual({
      x: [0, 240], // firmware 240 tighter than explicit 250
      y: [0, 150], // explicit 150 tighter than firmware 160
      z: [-35, 0], // firmware ceiling -35 tighter than explicit -40
    });
  });
});
