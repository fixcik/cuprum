import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api", () => ({
  api: {
    machine: {
      send: vi.fn(),
      unlock: vi.fn(),
      feedHold: vi.fn(),
      cycleStart: vi.fn(),
      softReset: vi.fn(),
      override: vi.fn(),
    },
    emitConsoleHome: vi.fn(),
    emitConsoleConnect: vi.fn(),
    emitConsoleDisconnect: vi.fn(),
  },
}));

const runHoming = vi.fn();
const connect = vi.fn();
const disconnect = vi.fn();
vi.mock("@/machineStore", () => ({
  useMachine: { getState: () => ({ runHoming, connect, disconnect }) },
}));

import { api } from "@/lib/api";
import { mainMachineActions, consoleMachineActions } from "./MachineActionsContext";

beforeEach(() => vi.clearAllMocks());

describe("console wiring", () => {
  it("routes home/connect/disconnect as intents to main window", () => {
    const a = consoleMachineActions();
    a.home();
    a.connect("/dev/x", 115200);
    a.disconnect();
    expect(api.emitConsoleHome).toHaveBeenCalled();
    expect(api.emitConsoleConnect).toHaveBeenCalledWith("/dev/x", 115200);
    expect(api.emitConsoleDisconnect).toHaveBeenCalled();
  });

  it("routes stateless writes directly to backend", () => {
    const a = consoleMachineActions();
    a.unlock();
    a.softReset();
    a.override("feed", "+10");
    expect(api.machine.unlock).toHaveBeenCalled();
    expect(api.machine.softReset).toHaveBeenCalled();
    expect(api.machine.override).toHaveBeenCalledWith("feed", "+10");
  });

  it("does NOT route connect/disconnect through backend machine calls", () => {
    const a = consoleMachineActions();
    a.connect("/dev/x", 115200);
    a.disconnect();
    expect(api.machine.connect).toBeUndefined();
    expect(api.machine.disconnect).toBeUndefined();
  });
});

describe("main wiring", () => {
  it("routes home/connect/disconnect through the store", () => {
    const a = mainMachineActions();
    a.home();
    a.connect("/dev/x", 115200);
    a.disconnect();
    expect(runHoming).toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith("/dev/x", 115200);
    expect(disconnect).toHaveBeenCalled();
  });

  it("routes stateless writes directly to backend", () => {
    const a = mainMachineActions();
    a.send("G0 X0");
    a.feedHold();
    a.cycleStart();
    expect(api.machine.send).toHaveBeenCalledWith("G0 X0");
    expect(api.machine.feedHold).toHaveBeenCalled();
    expect(api.machine.cycleStart).toHaveBeenCalled();
  });

  it("does NOT emit console intents for home/connect/disconnect", () => {
    const a = mainMachineActions();
    a.home();
    a.connect("/dev/x", 115200);
    a.disconnect();
    expect(api.emitConsoleHome).not.toHaveBeenCalled();
    expect(api.emitConsoleConnect).not.toHaveBeenCalled();
    expect(api.emitConsoleDisconnect).not.toHaveBeenCalled();
  });
});
