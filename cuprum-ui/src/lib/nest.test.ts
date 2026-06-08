import { describe, it, expect } from "vitest";
import { DEFAULT_NEST } from "@/lib/nest";

describe("DEFAULT_NEST", () => {
  it("defaults to a single corner copy, not an array", () => {
    expect(DEFAULT_NEST.enabled).toBe(false);
    expect(DEFAULT_NEST.corner).toBe("bl");
  });

  it("carries sane array defaults for when nesting is turned on", () => {
    expect(DEFAULT_NEST.fillMode).toBe("copies");
    expect(DEFAULT_NEST.copies).toBe(6);
    expect(DEFAULT_NEST.marginMm).toBe(5);
    expect(DEFAULT_NEST.gapMm).toBe(2);
  });

  it("defaults mixRotation on (mixed-orientation packing by default)", () => {
    expect(DEFAULT_NEST.mixRotation).toBe(true);
  });
});
