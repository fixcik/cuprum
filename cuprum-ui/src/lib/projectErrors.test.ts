import { describe, it, expect } from "vitest";
import { isProjectNotFound, projectDisplayName } from "@/lib/projectErrors";

describe("isProjectNotFound", () => {
  it("matches the stable PROJECT_NOT_FOUND token (case-insensitive)", () => {
    expect(isProjectNotFound("PROJECT_NOT_FOUND")).toBe(true);
  });

  it("matches common OS missing-file errors", () => {
    expect(isProjectNotFound(new Error("No such file or directory (os error 2)"))).toBe(true);
    expect(isProjectNotFound("os error 2")).toBe(true);
  });

  it("is false for unrelated errors and nullish input", () => {
    expect(isProjectNotFound("permission denied")).toBe(false);
    expect(isProjectNotFound(null)).toBe(false);
  });
});

describe("projectDisplayName", () => {
  it("prefers the name from recents when the path is known", () => {
    expect(
      projectDisplayName("/x/y.cuprum", [{ path: "/x/y.cuprum", name: "My Board" }]),
    ).toBe("My Board");
  });

  it("falls back to the file stem without the .cuprum extension", () => {
    expect(projectDisplayName("/foo/bar/myproj.cuprum", [])).toBe("myproj");
  });

  it("handles Windows separators and a case-insensitive extension", () => {
    expect(projectDisplayName("C:\\a\\b\\proj.cuprum", [])).toBe("proj");
    expect(projectDisplayName("/x/board.CUPRUM", [])).toBe("board");
  });
});
