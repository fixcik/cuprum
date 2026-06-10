import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

/**
 * Canary for the Tailwind utility generator (issue #541).
 *
 * A `border-warning/50` rule was once observed (in a live dev session) carrying
 * the body of `border-primary/40`, which led to inline-style workarounds. The
 * investigation concluded the generator output on disk was always correct and
 * the observation was a stale dev-server artifact — but if the generator ever
 * does miscompile an opacity-modified colour utility on this machine, this test
 * catches it: it compiles the project's real `@theme inline` tokens with the
 * real `tailwindcss` package and asserts every utility references its own token
 * at its own opacity.
 */

const themeCss = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const styles = readFileSync(join(here, "styles.css"), "utf8");
  const theme = styles.match(/@theme inline \{[^}]*\}/);
  if (!theme) throw new Error("styles.css: @theme inline block not found");
  return `${theme[0]}\n@tailwind utilities;`;
})();

/** Compile a single candidate class and return its generated CSS. The compiler
 * accumulates candidates across build() calls, so each case gets a fresh one. */
async function build(candidates: string[]): Promise<string> {
  return (await compile(themeCss)).build(candidates);
}

const cases: Array<{ candidate: string; token: string; percent: string }> = [
  { candidate: "border-warning/50", token: "--warning", percent: "50%" },
  { candidate: "border-warning/30", token: "--warning", percent: "30%" },
  { candidate: "border-warning/55", token: "--warning", percent: "55%" },
  { candidate: "border-info/30", token: "--info", percent: "30%" },
  { candidate: "border-primary/40", token: "--primary", percent: "40%" },
  { candidate: "border-destructive/30", token: "--destructive", percent: "30%" },
  { candidate: "bg-warning/10", token: "--warning", percent: "10%" },
];

describe("tailwind colour/opacity utilities compile to their own token", () => {
  it.each(cases)("$candidate → $token at $percent", async ({ candidate, token, percent }) => {
    const css = await build([candidate]);
    const escaped = candidate.replace("/", "\\/");
    expect(css).toContain(`.${escaped}`);
    expect(css).toContain(`color-mix(in oklab, hsl(var(${token})) ${percent}, transparent)`);
    // The only custom property the rule may reference is its own token.
    const foreign = [...css.matchAll(/var\((--[a-z-]+)\)/g)]
      .map((m) => m[1])
      .filter((v) => v !== token);
    expect(foreign).toEqual([]);
  });

  it("text-warning (no modifier) resolves the warning token directly", async () => {
    const css = await build(["text-warning"]);
    expect(css).toContain("hsl(var(--warning))");
    expect(css).not.toContain("--primary");
  });
});
