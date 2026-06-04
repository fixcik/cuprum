import { describe, it, expect } from "vitest";
import { placeHud } from "@/lib/hudPlacement";

const base = {
  viewportW: 800,
  hudW: 200,
  hudH: 40,
  rulerTop: 24,
  rulerLeft: 30,
};

describe("placeHud", () => {
  it("places above the bbox when there is room", () => {
    const r = placeHud({ ...base, bboxScreen: { left: 300, right: 400, top: 200, bottom: 260 } });
    expect(r.placement).toBe("top");
    expect(r.top).toBe(200 - 12 - 40); // bbox.top - gap - hudH
    expect(r.left).toBe(350 - 100); // centerX - hudW/2
    expect(r.caretLeft).toBe(100); // over the bbox centre
  });

  it("flips below when it would collide with the top ruler band", () => {
    const r = placeHud({ ...base, bboxScreen: { left: 300, right: 400, top: 30, bottom: 90 } });
    expect(r.placement).toBe("bottom");
    expect(r.top).toBe(90 + 12); // bbox.bottom + gap
  });

  it("clamps left at the left edge (ruler band + pad)", () => {
    const r = placeHud({ ...base, bboxScreen: { left: 0, right: 20, top: 200, bottom: 260 } });
    expect(r.left).toBe(30 + 8); // rulerLeft + pad
    expect(r.caretLeft).toBeGreaterThanOrEqual(8); // caret stays inside the HUD
  });

  it("clamps right at the right edge", () => {
    const r = placeHud({ ...base, bboxScreen: { left: 790, right: 800, top: 200, bottom: 260 } });
    expect(r.left).toBe(800 - 200 - 8); // viewportW - hudW - pad
  });

  it("keeps the caret over the board centre within HUD bounds", () => {
    const r = placeHud({ ...base, bboxScreen: { left: 0, right: 10, top: 200, bottom: 260 } });
    // centre at 5; HUD clamped to left=38; caret would be 5-38<0 → clamped to pad
    expect(r.caretLeft).toBe(8);
  });
});
