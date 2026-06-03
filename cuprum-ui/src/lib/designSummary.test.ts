import { describe, it, expect } from "vitest";
import { rollupVerdicts } from "@/lib/designSummary";

describe("rollupVerdicts", () => {
  it("counts each verdict and skips unsettled ones", () => {
    expect(rollupVerdicts(["ok", "ok", "warn", "block", null, undefined])).toEqual({
      ok: 2,
      warn: 1,
      block: 1,
    });
  });

  it("is all-zero for empty input", () => {
    expect(rollupVerdicts([])).toEqual({ ok: 0, warn: 0, block: 0 });
  });
});
