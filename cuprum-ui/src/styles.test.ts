import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "tailwindcss";
import { describe, expect, it } from "vitest";

/**
 * Canary for the Tailwind utility generator (issue #541).
 *
 * `border-warning/*` borders once rendered "faint", which was blamed on the
 * generator and worked around with inline styles. The generator was in fact
 * correct (the real culprit was an un-layered `* { border-color }` rule — see
 * the layering guard below), but keep the generator honest anyway: compile the
 * project's real `@theme inline` tokens with the real `tailwindcss` package
 * and assert every utility references its own token at its own opacity.
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

/**
 * Cascade-layer guard (the actual root cause of #541): an un-layered
 * declaration beats EVERY layered one, so a bare `* { border-color: … }` in
 * styles.css silently overrides all `border-{color}` utilities (which live in
 * `@layer utilities`). Global element defaults must sit inside `@layer base`.
 *
 * The check compiles the real styles.css (resolving `@import "tailwindcss"`
 * from node_modules) and walks the output: any top-level (= outside every
 * `@layer`/`@media` block) rule whose selector list contains the universal
 * selector and whose body sets a border colour is a regression.
 */
describe("styles.css cascade layering", () => {
  it("has no un-layered universal-selector rule that sets border-color", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const require = createRequire(import.meta.url);
    const twBase = dirname(require.resolve("tailwindcss/package.json"));

    const compiler = await compile(readFileSync(join(here, "styles.css"), "utf8"), {
      base: here,
      async loadStylesheet(id, base) {
        const file = id.startsWith(".")
          ? join(base, id)
          : join(twBase, id === "tailwindcss" ? "index.css" : id.replace(/^tailwindcss\//, ""));
        return { path: file, base: dirname(file), content: readFileSync(file, "utf8") };
      },
    });
    const css = compiler.build([]);

    const offenders: string[] = [];
    let depth = 0;
    let topLevelSelector: string | null = null;
    let body = "";
    for (const line of css.split("\n")) {
      if (depth === 0 && line.includes("{")) {
        const braceIdx = line.indexOf("{");
        const selector = line.slice(0, braceIdx).trim();
        // At-rules (@layer/@media/@supports/@property…) are containers, not rules.
        topLevelSelector = selector.startsWith("@") ? null : selector;
        // Keep the rest of the line so single-line rules are not missed.
        body = line.slice(braceIdx + 1);
      } else if (depth > 0 && topLevelSelector !== null) {
        body += line;
      }
      depth += (line.match(/\{/g)?.length ?? 0) - (line.match(/\}/g)?.length ?? 0);
      if (depth === 0 && topLevelSelector !== null) {
        const hitsUniversal = topLevelSelector.split(",").some((s) => s.trim().startsWith("*"));
        if (hitsUniversal && body.includes("border-color")) offenders.push(topLevelSelector);
        topLevelSelector = null;
      }
    }
    expect(offenders).toEqual([]);
  });
});
