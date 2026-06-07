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
});
