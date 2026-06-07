import { describe, it, expect } from "vitest";
import { stitchLoops, outlineLoops, outlinePathD, type Vec2 } from "@/lib/boardOutline";

const v = (x: number, y: number): Vec2 => ({ x, y });
const xy = (loop: Vec2[]) => loop.map((p) => [p.x, p.y]);
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

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
    expect(loops[0][0]).toEqual(v(0, 0));
    expect(dist(loops[0][loops[0].length - 1], v(0, 0))).toBeLessThan(0.05);
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

// --- SVG reconstruction (golden parity with the previous three/SVGLoader impl) ---
// Inputs use the exact shape the renderer (cuprum-gerber/src/svg.rs) emits for an
// additive Edge_Cuts layer: a `<g fill="currentColor" stroke="currentColor">`
// wrapping stroked `<path d="M.. L..">` segments; filled flashes carry stroke="none".

const seg = (x1: number, y1: number, x2: number, y2: number) =>
  `<path d="M${x1.toFixed(4)} ${y1.toFixed(4)} L${x2.toFixed(4)} ${y2.toFixed(4)}" fill="none" stroke-width="0.1000" stroke-linecap="round" stroke-linejoin="round"/>`;
const wrap = (inner: string) => `<g fill="currentColor" stroke="currentColor">${inner}</g>`;

const square = wrap(seg(0, 0, 2, 0) + seg(2, 0, 2, 2) + seg(2, 2, 0, 2) + seg(0, 2, 0, 0));
const innerCut = seg(0.5, 0.5, 1.5, 0.5) + seg(1.5, 0.5, 1.5, 1.5) + seg(1.5, 1.5, 0.5, 1.5) + seg(0.5, 1.5, 0.5, 0.5);
const nested = wrap(seg(0, 0, 4, 0) + seg(4, 0, 4, 4) + seg(4, 4, 0, 4) + seg(0, 4, 0, 0) + innerCut);
const withCircle = wrap(
  seg(0, 0, 2, 0) + seg(2, 0, 2, 2) + seg(2, 2, 0, 2) + seg(0, 2, 0, 0) +
    `<circle cx="1.0000" cy="1.0000" r="0.3000" stroke="none"/>`,
);
const arc = wrap(
  `<path d="M0.0000 0.0000 L2.0000 0.0000 L1.9319 0.5176 L1.7321 1.0000 L1.4142 1.4142" fill="none" stroke-width="0.1000" stroke-linecap="round" stroke-linejoin="round"/>` +
    seg(1.4142, 1.4142, 0, 0),
);

describe("outlinePathD (golden parity)", () => {
  it("reconstructs a square outline", () => {
    expect(outlinePathD(square)).toBe("M0.000 0.000 L 2.000 0.000 L 2.000 2.000 L 0.000 2.000 Z");
  });

  it("emits both loops, largest first, for a board with a cutout", () => {
    expect(outlinePathD(nested)).toBe(
      "M0.000 0.000 L 4.000 0.000 L 4.000 4.000 L 0.000 4.000 Z M0.500 0.500 L 1.500 0.500 L 1.500 1.500 L 0.500 1.500 Z",
    );
  });

  it("ignores filled flashes (stroke=none circles)", () => {
    expect(outlinePathD(withCircle)).toBe("M0.000 0.000 L 2.000 0.000 L 2.000 2.000 L 0.000 2.000 Z");
  });

  it("keeps tessellated-arc polyline vertices", () => {
    expect(outlinePathD(arc)).toBe("M0.000 0.000 L 2.000 0.000 L 1.932 0.518 L 1.732 1.000 L 1.414 1.414 Z");
  });

  it("returns null when there is no outline", () => {
    expect(outlinePathD(wrap(""))).toBeNull();
  });
});

describe("outlineLoops (golden parity)", () => {
  it("returns one 4-vertex loop for a square", () => {
    const loops = outlineLoops(square);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toHaveLength(4);
  });

  it("orders loops largest-area first", () => {
    const loops = outlineLoops(nested);
    expect(loops).toHaveLength(2);
    const width = (l: Vec2[]) => Math.max(...l.map((p) => p.x)) - Math.min(...l.map((p) => p.x));
    expect(width(loops[0])).toBeGreaterThan(width(loops[1])); // outer before inner
  });
});
