import { describe, expect, it } from "vitest";
import { issueUrl, REPO_ISSUE_BASE } from "./crashReport";

describe("issueUrl", () => {
  it("builds an encoded prefilled GitHub issue url", () => {
    const url = issueUrl("Title", "Body with spaces & #hash");
    expect(url.startsWith(REPO_ISSUE_BASE)).toBe(true);
    expect(url).toContain("title=Title");
    expect(url).toContain(encodeURIComponent("Body with spaces & #hash"));
  });
  it("truncates body to keep URL under the GitHub limit", () => {
    const url = issueUrl("T", "x".repeat(20000));
    expect(url.length).toBeLessThan(8000);
  });
});
