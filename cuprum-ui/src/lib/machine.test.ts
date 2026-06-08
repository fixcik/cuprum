import { describe, it, expect } from "vitest";
import {
  newCncMachine,
  newUvMachine,
  nextMachineId,
  toolChangeZWarning,
  cncConfigDirtyKeys,
  resetCncToFactory,
  uvConfigDirtyKeys,
  resetUvToFactory,
  CNC_CONFIG_KEYS,
  DEFAULT_CNC_MACHINE,
  DEFAULT_UV_MACHINE,
  type CncMachine,
  type UvLcdMachine,
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

describe("cncConfigDirtyKeys", () => {
  it("is empty for an unmodified default machine", () => {
    expect(cncConfigDirtyKeys(DEFAULT_CNC_MACHINE).size).toBe(0);
  });

  it("flags a changed flat field", () => {
    const m: CncMachine = { ...DEFAULT_CNC_MACHINE, spindleMaxRpm: 12000 };
    expect([...cncConfigDirtyKeys(m)]).toEqual(["spindleMaxRpm"]);
  });

  it("flags changed nested envelope and backlash fields by dotted key", () => {
    const m: CncMachine = {
      ...DEFAULT_CNC_MACHINE,
      workEnvelopeMm: { ...DEFAULT_CNC_MACHINE.workEnvelopeMm, y: 200 },
      backlashMm: { ...DEFAULT_CNC_MACHINE.backlashMm, z: 0.2 },
    };
    const d = cncConfigDirtyKeys(m);
    expect(d.has("envelope.y")).toBe(true);
    expect(d.has("envelope.x")).toBe(false);
    expect(d.has("backlash.z")).toBe(true);
    expect(d.size).toBe(2);
  });

  it("flags changed boolean and string fields", () => {
    const m: CncMachine = {
      ...DEFAULT_CNC_MACHINE,
      hasProbe: !DEFAULT_CNC_MACHINE.hasProbe,
      prependGcode: "G21",
    };
    const d = cncConfigDirtyKeys(m);
    expect(d.has("hasProbe")).toBe(true);
    expect(d.has("prependGcode")).toBe(true);
  });

  it("only reports keys from CNC_CONFIG_KEYS", () => {
    const m: CncMachine = {
      ...DEFAULT_CNC_MACHINE,
      workEnvelopeMm: { x: 1, y: 2, z: 3 },
      spindleMaxRpm: 1,
      spindleControllable: !DEFAULT_CNC_MACHINE.spindleControllable,
      spindleHasPwm: !DEFAULT_CNC_MACHINE.spindleHasPwm,
      safeZMm: 99,
      machineSafeZMm: 99,
      toolChangeZMm: 99,
      hasProbe: !DEFAULT_CNC_MACHINE.hasProbe,
      probeFeedMmMin: 1,
      probeMaxDistMm: 1,
      probePlateOffsetMm: 1,
      runoutMm: 1,
      backlashMm: { x: 1, y: 1, z: 1 },
      baud: 1,
      prependGcode: "a",
      appendGcode: "b",
    };
    const d = cncConfigDirtyKeys(m);
    expect(d.size).toBe(CNC_CONFIG_KEYS.length);
    for (const k of d) expect(CNC_CONFIG_KEYS).toContain(k);
  });
});

describe("resetCncToFactory", () => {
  it("returns a patch that clears every dirty config key", () => {
    const m: CncMachine = {
      ...DEFAULT_CNC_MACHINE,
      spindleMaxRpm: 12000,
      workEnvelopeMm: { x: 1, y: 2, z: 3 },
      backlashMm: { x: 0.9, y: 0.9, z: 0.9 },
      prependGcode: "G21",
    };
    const reset: CncMachine = { ...m, ...resetCncToFactory(m) };
    expect(cncConfigDirtyKeys(reset).size).toBe(0);
  });

  it("preserves identity and runtime state (id/name/port/workZero/jog/dialect)", () => {
    const m: CncMachine = {
      ...DEFAULT_CNC_MACHINE,
      id: "machine-7",
      name: "My CNC",
      port: "/dev/ttyUSB0",
      workZeroMm: { x: 10, y: 20 },
      jogFeedMmMin: 999,
      jogStepsMm: [0.5, 5],
      safeZMm: 99,
    };
    const patch = resetCncToFactory(m);
    expect(patch.id).toBeUndefined();
    expect(patch.name).toBeUndefined();
    expect(patch.port).toBeUndefined();
    expect(patch.workZeroMm).toBeUndefined();
    expect(patch.jogFeedMmMin).toBeUndefined();
    expect(patch.gcodeDialect).toBeUndefined();
    const reset: CncMachine = { ...m, ...patch };
    expect(reset.id).toBe("machine-7");
    expect(reset.name).toBe("My CNC");
    expect(reset.port).toBe("/dev/ttyUSB0");
    expect(reset.workZeroMm).toEqual({ x: 10, y: 20 });
    expect(reset.jogFeedMmMin).toBe(999);
    expect(reset.safeZMm).toBe(DEFAULT_CNC_MACHINE.safeZMm);
  });
});

describe("uvConfigDirtyKeys + resetUvToFactory", () => {
  it("is empty for an unmodified default UV machine", () => {
    expect(uvConfigDirtyKeys(DEFAULT_UV_MACHINE).size).toBe(0);
  });

  it("flags changed screen dimensions and resets them", () => {
    const m: UvLcdMachine = { ...DEFAULT_UV_MACHINE, screenWidthMm: 200 };
    expect([...uvConfigDirtyKeys(m)]).toEqual(["screenWidthMm"]);
    const reset: UvLcdMachine = { ...m, ...resetUvToFactory(m) };
    expect(uvConfigDirtyKeys(reset).size).toBe(0);
    expect(reset.id).toBe(m.id);
    expect(reset.name).toBe(m.name);
  });
});
