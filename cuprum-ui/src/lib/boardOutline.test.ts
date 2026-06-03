import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { stitchLoops } from "@/lib/boardOutline";

const v = (x: number, y: number) => new THREE.Vector2(x, y);
const xy = (loop: THREE.Vector2[]) => loop.map((p) => [p.x, p.y]);

describe("stitchLoops", () => {
  it("chains four edge segments into one closed loop", () => {
    const loops = stitchLoops([
      [v(0, 0), v(2, 0)],
      [v(2, 0), v(2, 2)],
      [v(2, 2), v(0, 2)],
      [v(0, 2), v(0, 0)],
    ]);
    expect(loops).toHaveLength(1);
    expect(xy(loops[0])).toEqual([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ]);
  });

  it("matches segments regardless of their direction", () => {
    const loops = stitchLoops([
      [v(0, 0), v(2, 0)],
      [v(2, 2), v(2, 0)], // reversed
      [v(2, 2), v(0, 2)],
      [v(0, 0), v(0, 2)], // reversed
    ]);
    expect(loops).toHaveLength(1);
    expect(loops[0][0].equals(v(0, 0))).toBe(true);
    expect(loops[0][loops[0].length - 1].distanceTo(v(0, 0))).toBeLessThan(0.05);
  });

  it("keeps disjoint outlines as separate loops", () => {
    const loops = stitchLoops([
      [v(0, 0), v(1, 0)],
      [v(1, 0), v(0, 0)],
      [v(10, 10), v(11, 10)],
      [v(11, 10), v(10, 10)],
    ]);
    expect(loops).toHaveLength(2);
  });
});
