import { describe, it, expect } from "vitest";
import { designIdsToLoad } from "./useDesignPreviewImages";

describe("designIdsToLoad", () => {
  it("dedupes repeated instances of the same design to one id", () => {
    const instances = [{ design_id: "a" }, { design_id: "a" }, { design_id: "b" }];
    expect(designIdsToLoad(instances, {}).sort()).toEqual(["a", "b"]);
  });

  it("skips designs already loaded or in flight", () => {
    const instances = [{ design_id: "a" }, { design_id: "b" }];
    expect(designIdsToLoad(instances, { a: true })).toEqual(["b"]);
  });

  it("returns empty when nothing placed", () => {
    expect(designIdsToLoad([], {})).toEqual([]);
  });
});
