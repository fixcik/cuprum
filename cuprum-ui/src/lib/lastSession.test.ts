import { describe, it, expect } from "vitest";
import { parseLastSession } from "@/lib/lastSession";

describe("parseLastSession", () => {
  it("returns null for absent / empty raw", () => {
    expect(parseLastSession(null)).toBeNull();
    expect(parseLastSession("")).toBeNull();
  });

  it("returns null for non-JSON or non-object shapes", () => {
    expect(parseLastSession("not json")).toBeNull();
    expect(parseLastSession("42")).toBeNull();
    expect(parseLastSession("null")).toBeNull();
    expect(parseLastSession('"str"')).toBeNull();
  });

  it("returns null for the empty default (pathless Home)", () => {
    expect(parseLastSession('{"path":null,"view":"home"}')).toBeNull();
  });

  it("returns null for a pathless project view (degenerate)", () => {
    expect(parseLastSession('{"path":null,"view":"project"}')).toBeNull();
    expect(parseLastSession('{"path":"","view":"project"}')).toBeNull();
  });

  it("restores an open project + project view", () => {
    expect(parseLastSession('{"path":"/a/b.cuprum","view":"project"}')).toEqual({
      path: "/a/b.cuprum",
      view: "project",
    });
  });

  it("keeps the project path while honoring a non-project view", () => {
    expect(parseLastSession('{"path":"/a/b.cuprum","view":"equipment"}')).toEqual({
      path: "/a/b.cuprum",
      view: "equipment",
    });
  });

  it("restores pathless equipment/settings views", () => {
    expect(parseLastSession('{"path":null,"view":"equipment"}')).toEqual({
      path: null,
      view: "equipment",
    });
    expect(parseLastSession('{"view":"settings"}')).toEqual({
      path: null,
      view: "settings",
    });
  });

  it("falls back to Home for an unknown view (path still wins)", () => {
    expect(parseLastSession('{"path":"/a/b.cuprum","view":"garbage"}')).toEqual({
      path: "/a/b.cuprum",
      view: "home",
    });
  });
});
