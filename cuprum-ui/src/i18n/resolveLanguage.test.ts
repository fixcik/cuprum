import { describe, it, expect, afterEach } from "vitest";
import { resolveLanguage, detectSystemLanguage } from "@/i18n/resolveLanguage";

const originalLang = navigator.language;
const setLang = (value: string) =>
  Object.defineProperty(navigator, "language", { value, configurable: true, writable: true });

afterEach(() => setLang(originalLang));

describe("detectSystemLanguage", () => {
  it("maps a Russian system locale to ru", () => {
    setLang("ru-RU");
    expect(detectSystemLanguage()).toBe("ru");
  });

  it("falls back to en for any other locale", () => {
    setLang("en-US");
    expect(detectSystemLanguage()).toBe("en");
    setLang("de-DE");
    expect(detectSystemLanguage()).toBe("en");
  });
});

describe("resolveLanguage", () => {
  it("passes an explicit setting through unchanged", () => {
    expect(resolveLanguage("en")).toBe("en");
    expect(resolveLanguage("ru")).toBe("ru");
  });

  it("resolves 'auto' via the system locale", () => {
    setLang("ru-RU");
    expect(resolveLanguage("auto")).toBe("ru");
    setLang("fr-FR");
    expect(resolveLanguage("auto")).toBe("en");
  });
});
