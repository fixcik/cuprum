// Verify en and ru have identical key sets across every namespace.
// Pure Node, no test runner. Exits non-zero on mismatch.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, "..", "src", "locales");
const LANGS = ["en", "ru"];

/** Recursively collect dotted key paths from a JSON object. */
function keys(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...keys(v, path));
    else out.push(path);
  }
  return out.sort();
}

function load(lang) {
  const dir = join(localesDir, lang);
  const map = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const ns = file.replace(/\.json$/, "");
    map[ns] = keys(JSON.parse(readFileSync(join(dir, file), "utf8")));
  }
  return map;
}

const [en, ru] = LANGS.map(load);
const namespaces = new Set([...Object.keys(en), ...Object.keys(ru)]);
let failed = false;

for (const ns of [...namespaces].sort()) {
  const a = new Set(en[ns] ?? []);
  const b = new Set(ru[ns] ?? []);
  const missingRu = [...a].filter((k) => !b.has(k));
  const missingEn = [...b].filter((k) => !a.has(k));
  if (!en[ns]) { console.error(`[i18n] namespace "${ns}" missing in en`); failed = true; }
  if (!ru[ns]) { console.error(`[i18n] namespace "${ns}" missing in ru`); failed = true; }
  if (missingRu.length) { console.error(`[i18n] ${ns}: missing in ru: ${missingRu.join(", ")}`); failed = true; }
  if (missingEn.length) { console.error(`[i18n] ${ns}: missing in en: ${missingEn.join(", ")}`); failed = true; }
}

if (failed) process.exit(1);
console.log("[i18n] en/ru key parity OK");
