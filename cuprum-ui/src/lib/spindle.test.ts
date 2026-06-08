import { describe, expect, it } from "vitest";
import { spindleFraction, fractionToRpm, rpmToSWord, sWordToRpm } from "@/lib/spindle";

describe("spindleFraction", () => {
  it("is the reported S over the GRBL ceiling", () => {
    expect(spindleFraction(1000, 1000)).toBe(1);
    expect(spindleFraction(500, 1000)).toBe(0.5);
    expect(spindleFraction(0, 1000)).toBe(0);
  });

  it("clamps to [0, 1] and guards a zero ceiling", () => {
    expect(spindleFraction(1500, 1000)).toBe(1);
    expect(spindleFraction(-10, 1000)).toBe(0);
    expect(spindleFraction(100, 0)).toBe(0);
  });
});

describe("fractionToRpm", () => {
  it("scales a fraction up to the physical max", () => {
    expect(fractionToRpm(1, 12000)).toBe(12000);
    expect(fractionToRpm(0.5, 12000)).toBe(6000);
    expect(fractionToRpm(0, 12000)).toBe(0);
  });
});

describe("rpmToSWord", () => {
  it("scales real RPM down to the S word by the firmware ceiling", () => {
    // physical 12000 RPM mapped onto a $30=1000 firmware ceiling.
    expect(rpmToSWord(12000, 12000, 1000)).toBe(1000);
    expect(rpmToSWord(6000, 12000, 1000)).toBe(500);
    expect(rpmToSWord(0, 12000, 1000)).toBe(0);
  });

  it("is identity when the ceiling equals the physical max", () => {
    expect(rpmToSWord(8000, 12000, 12000)).toBe(8000);
  });

  it("clamps the input to the physical max", () => {
    expect(rpmToSWord(99999, 12000, 1000)).toBe(1000);
    expect(rpmToSWord(-100, 12000, 1000)).toBe(0);
  });

  it("guards a non-positive physical max", () => {
    expect(rpmToSWord(5000, 0, 1000)).toBe(0);
  });
});

describe("sWordToRpm", () => {
  it("scales an S word up to real RPM by the firmware ceiling", () => {
    // $31=100 min S word on a $30=1000 ceiling, physical max 12000.
    expect(sWordToRpm(100, 12000, 1000)).toBe(1200);
    expect(sWordToRpm(500, 12000, 1000)).toBe(6000);
    expect(sWordToRpm(0, 12000, 1000)).toBe(0);
  });

  it("is identity when the ceiling equals the physical max", () => {
    expect(sWordToRpm(8000, 12000, 12000)).toBe(8000);
  });

  it("clamps the input to the ceiling", () => {
    expect(sWordToRpm(99999, 12000, 1000)).toBe(12000);
    expect(sWordToRpm(-100, 12000, 1000)).toBe(0);
  });

  it("round-trips with rpmToSWord", () => {
    expect(sWordToRpm(rpmToSWord(6000, 12000, 1000), 12000, 1000)).toBe(6000);
  });

  it("guards a non-positive ceiling", () => {
    expect(sWordToRpm(500, 12000, 0)).toBe(0);
  });
});
