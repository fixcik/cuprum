import { describe, it, expect } from "vitest";
import { linesSince } from "./consoleRelay";
import type { ConsoleLine } from "@/machineStore";

const mk = (seq: number): ConsoleLine => ({ seq, ts: seq, dir: "rx", text: `l${seq}` });

describe("linesSince", () => {
  it("returns only lines with seq greater than lastSeq", () => {
    const lines = [mk(1), mk(2), mk(3)];
    expect(linesSince(lines, 1).map((l) => l.seq)).toEqual([2, 3]);
  });
  it("returns all when lastSeq is 0", () => {
    expect(linesSince([mk(1), mk(2)], 0).map((l) => l.seq)).toEqual([1, 2]);
  });
  it("returns empty when nothing newer (and after front-trim)", () => {
    // buffer trimmed from the front: seq 1..2 dropped, only 3..4 remain
    expect(linesSince([mk(3), mk(4)], 4)).toEqual([]);
  });
  it("survives front-trim: returns the still-present newer tail", () => {
    expect(linesSince([mk(3), mk(4), mk(5)], 3).map((l) => l.seq)).toEqual([4, 5]);
  });
});
