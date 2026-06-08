import { afterEach, describe, expect, it } from "vitest";
import { classifyResponse, loadHistory, rememberCommand } from "./consoleHistory";

afterEach(() => localStorage.clear());

describe("classifyResponse", () => {
  it("treats a bare ok as valid (any case/whitespace)", () => {
    expect(classifyResponse("ok")).toBe("valid");
    expect(classifyResponse("  OK \n")).toBe("valid");
  });

  it("treats ALARM as valid — the command was well-formed, it just tripped a limit", () => {
    expect(classifyResponse("ALARM:2")).toBe("valid");
    expect(classifyResponse("alarm")).toBe("valid");
  });

  it("treats error: as invalid — GRBL rejected the line", () => {
    expect(classifyResponse("error:20")).toBe("invalid");
  });

  it("returns null for non-terminal lines (status, settings, banner)", () => {
    expect(classifyResponse("<Idle|MPos:0,0,0>")).toBeNull();
    expect(classifyResponse("$22=1")).toBeNull();
    expect(classifyResponse("Grbl 1.1h ['$' for help]")).toBeNull();
    // A G-code echo that merely contains "ok" mid-word is not a verdict.
    expect(classifyResponse("token")).toBeNull();
  });
});

describe("rememberCommand", () => {
  it("appends newest-last and trims blanks", () => {
    rememberCommand("G0 X0");
    rememberCommand("  ");
    rememberCommand("G1 Y5");
    expect(loadHistory()).toEqual(["G0 X0", "G1 Y5"]);
  });

  it("moves a repeated command to the newest slot without duplicating", () => {
    rememberCommand("$H");
    rememberCommand("G0 X0");
    rememberCommand("$H");
    expect(loadHistory()).toEqual(["G0 X0", "$H"]);
  });

  it("caps the history at 100 entries, keeping the newest", () => {
    for (let i = 0; i < 130; i++) rememberCommand(`cmd${i}`);
    const h = loadHistory();
    expect(h).toHaveLength(100);
    expect(h[0]).toBe("cmd30");
    expect(h[99]).toBe("cmd129");
  });

  it("tolerates corrupt storage", () => {
    localStorage.setItem("cuprum-console-history", "{not json");
    expect(loadHistory()).toEqual([]);
    expect(rememberCommand("G0 X0")).toEqual(["G0 X0"]);
  });
});
