import { describe, it, expect } from "vitest";
import { FLAGS, flagDefault, resolveFlag, type FlagKey } from "@/lib/flags";

const def = { label: "x" }; // defaults: dev→true, prod→false

describe("flagDefault", () => {
  it("defaults on in dev, off in prod", () => {
    expect(flagDefault(def, true)).toBe(true);
    expect(flagDefault(def, false)).toBe(false);
  });
  it("honours explicit per-env defaults", () => {
    expect(flagDefault({ label: "x", defaultDev: false }, true)).toBe(false);
    expect(flagDefault({ label: "x", defaultProd: true }, false)).toBe(true);
  });
});

describe("resolveFlag", () => {
  it("override wins over env default", () => {
    expect(resolveFlag(def, true, false)).toBe(true); // forced on in prod
    expect(resolveFlag(def, false, true)).toBe(false); // forced off in dev
  });
  it("undefined override falls back to env default", () => {
    expect(resolveFlag(def, undefined, true)).toBe(true);
    expect(resolveFlag(def, undefined, false)).toBe(false);
  });
});

describe("FLAGS registry", () => {
  it("contains the initial hidden features", () => {
    const keys = Object.keys(FLAGS) as FlagKey[];
    expect(keys).toContain("uvExposure");
    expect(keys).toContain("cncMilling");
  });
});
