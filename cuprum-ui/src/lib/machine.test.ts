import { describe, it, expect } from "vitest";
import {
  newCncMachine,
  newUvMachine,
  nextMachineId,
  toolChangeZWarning,
  DEFAULT_CNC_MACHINE,
  DEFAULT_UV_MACHINE,
  type Machine,
} from "./machine";

const seed = (): Machine[] => [DEFAULT_CNC_MACHINE, DEFAULT_UV_MACHINE];

describe("toolChangeZWarning", () => {
  it("ok when safeZ ≤ toolChangeZ ≤ envelope", () => {
    expect(toolChangeZWarning({ safeZMm: 5, toolChangeZMm: 20, envZMm: 45 })).toBeNull();
  });
  it("flags toolChangeZ below safeZ", () => {
    expect(toolChangeZWarning({ safeZMm: 10, toolChangeZMm: 5, envZMm: 45 })).toBe("below-safe");
  });
  it("flags negative toolChangeZ", () => {
    expect(toolChangeZWarning({ safeZMm: 1, toolChangeZMm: -1, envZMm: 45 })).toBe("below-safe");
  });
  it("flags toolChangeZ beyond the envelope", () => {
    expect(toolChangeZWarning({ safeZMm: 5, toolChangeZMm: 50, envZMm: 45 })).toBe("over-travel");
  });
});

describe("newCncMachine", () => {
  it("produces a fresh CNC machine with the next id and default fields", () => {
    const machines = seed();
    const m = newCncMachine(machines);
    expect(m.kind).toBe("cnc");
    expect(m.id).toBe(nextMachineId(machines));
    expect(m.id).toBe("machine-3");
    // unique name: must not collide with any existing machine name
    expect(machines.map((x) => x.name)).not.toContain(m.name);
    // remaining fields stay at the CNC defaults
    expect(m.baud).toBe(DEFAULT_CNC_MACHINE.baud);
    expect(m.workEnvelopeMm).toEqual(DEFAULT_CNC_MACHINE.workEnvelopeMm);
    expect(m.spindleControllable).toBe(DEFAULT_CNC_MACHINE.spindleControllable);
    expect(m.gcodeDialect).toBe(DEFAULT_CNC_MACHINE.gcodeDialect);
  });
});

describe("newUvMachine", () => {
  it("produces a fresh UV LCD machine with the next id and default fields", () => {
    const machines = seed();
    const m = newUvMachine(machines);
    expect(m.kind).toBe("uvlcd");
    expect(m.id).toBe(nextMachineId(machines));
    expect(machines.map((x) => x.name)).not.toContain(m.name);
    expect(m.screenWidthMm).toBe(DEFAULT_UV_MACHINE.screenWidthMm);
    expect(m.screenHeightMm).toBe(DEFAULT_UV_MACHINE.screenHeightMm);
  });
});

describe("unique name + id idempotence", () => {
  it("yields a distinct id and name when the builder is called again with its own output", () => {
    const machines = seed();
    const first = newCncMachine(machines);
    const next = newCncMachine([...machines, first]);
    expect(next.id).not.toBe(first.id);
    expect(next.name).not.toBe(first.name);
    // and neither collides with the base default name
    expect([first.name, next.name]).not.toContain(undefined);
  });

  it("does the same for UV machines", () => {
    const machines = seed();
    const first = newUvMachine(machines);
    const next = newUvMachine([...machines, first]);
    expect(next.id).not.toBe(first.id);
    expect(next.name).not.toBe(first.name);
  });
});
