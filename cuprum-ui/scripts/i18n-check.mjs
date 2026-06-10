// i18n gate, run as part of `pnpm build`. Two checks:
//   1. PARITY  — en and ru must have identical key sets per namespace (hard fail).
//   2. CODE-vs-JSON — every statically-resolvable t('…') key referenced in the
//      source must exist in the locales (hard fail); locale keys never referenced
//      get a non-fatal warning.
// Pure Node, no test runner. Exits non-zero on any hard failure.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const uiRoot = join(here, "..");
const localesDir = join(uiRoot, "src", "locales");
const srcDir = join(uiRoot, "src");
const LANGS = ["en", "ru"];
const DEFAULT_NS = "common"; // mirrors resources.ts DEFAULT_NS
const NS_SEP = ":"; // i18next default nsSeparator
// Plural/context suffixes: a base key `foo` in code is satisfied by `foo`, or by
// any `foo_<suffix>` the locale emits (CLDR plural categories + i18next context).
const SUFFIX_RE = /_(zero|one|two|few|many|other|[A-Za-z0-9]+)$/;

// ── locales ────────────────────────────────────────────────────────────────

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

// ── 1. parity ────────────────────────────────────────────────────────────────

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

// ── 2. code-vs-json ──────────────────────────────────────────────────────────

// A key is "defined" if EITHER locale carries it (parity above already flags a
// one-sided key). Index per namespace as a Set of base keys with the
// plural/context suffix stripped, so `foo` matches a `foo_other`-only locale.
const defined = {};
for (const ns of namespaces) {
  const all = new Set([...(en[ns] ?? []), ...(ru[ns] ?? [])]);
  const bases = new Set();
  for (const k of all) {
    bases.add(k);
    const stripped = k.replace(SUFFIX_RE, "");
    if (stripped !== k) bases.add(stripped);
  }
  defined[ns] = bases;
}

/** Walk src/ collecting .ts/.tsx, skipping tests, declarations and locales. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "locales" || entry.name === "node_modules") continue;
      out.push(...sourceFiles(full));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !/\.(test|bench)\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Strip line and block comments so commented-out t('…') don't register.
 *  Lenient: may truncate a line at a `//` inside a string literal, which only
 *  ever *under*-reports keys — the safe direction for a build gate. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// Candidate namespaces a bare key in a file may resolve against: every namespace
// passed to any useTranslation(...) in the file, plus the default. Lenient on
// purpose — precise per-binding scoping is infeasible and a false build failure
// is worse than missing a mis-scoped key (parity still runs).
function fileNamespaces(src) {
  const set = new Set([DEFAULT_NS]);
  const re = /useTranslation\(\s*(\[[^\]]*\]|["'`][^"'`]*["'`])?/g;
  let m;
  while ((m = re.exec(src))) {
    const arg = m[1];
    if (!arg) continue;
    for (const lit of arg.match(/["'`]([^"'`]+)["'`]/g) ?? []) {
      set.add(lit.slice(1, -1));
    }
  }
  return set;
}

// Translation-fn names bound in a file: always `t` (covers bare `t` and the
// `i18n.t(` / `i18next.t(` member calls), plus any alias from a renamed
// destructure `const { t: tc } = useTranslation("common")`. Per-file so the
// alternation never matches an unrelated function elsewhere.
function tFnNames(src) {
  const names = new Set(["t"]);
  const re = /\{\s*t(?:\s*:\s*([A-Za-z_$][\w$]*))?[^}]*\}\s*=\s*useTranslation/g;
  let m;
  while ((m = re.exec(src))) if (m[1]) names.add(m[1]);
  return names;
}

// Static string literal as first arg of <fn>(…) / i18n.t(…) / i18next.t(…). The
// lookbehind rejects mid-identifier matches (format(, parseInt(); a leading `.`
// (i18n.t) passes, which is what we want.
const I18NKEY_RE = /\bi18nKey=(["'])((?:[^"'\\]|\\.)*?)\1/g;
const tCallRe = (names) =>
  new RegExp(`(?<![\\w$])(?:${[...names].join("|")})\\(\\s*(["'\`])((?:[^"'\`\\\\]|\\\\.)*?)\\1`, "g");
const idArgRe = (names) =>
  new RegExp(`(?<![\\w$])(?:${[...names].join("|")})\\(\\s*[A-Za-z_$][\\w$.]*`, "g"); // t(someVar) / t(obj.key)

const missing = []; // { key, ns: string|null, candidates }
const dynamicPrefixes = []; // { ns: string|null, prefix, candidates } from t(`pre${…}`)
let dynamicSkipped = 0; // identifier args / interpolated templates we can't resolve
const referenced = new Set(); // `${ns} ${key}` actually resolved, for dead-key pass

function recordKey(rawKey, fileNs, isTemplateWithExpr) {
  // Split explicit namespace (`ns:key`); first separator only.
  let ns = null;
  let key = rawKey;
  const ci = rawKey.indexOf(NS_SEP);
  if (ci > 0 && namespaces.has(rawKey.slice(0, ci))) {
    ns = rawKey.slice(0, ci);
    key = rawKey.slice(ci + 1);
  }
  if (isTemplateWithExpr) {
    dynamicPrefixes.push({ ns, prefix: key, candidates: fileNs });
    return;
  }
  const cands = ns ? [ns] : [...fileNs];
  const hit = cands.find((n) => defined[n]?.has(key));
  if (hit) referenced.add(`${hit} ${key}`);
  else missing.push({ key, ns, candidates: ns ? [ns] : cands });
}

for (const file of sourceFiles(srcDir)) {
  const src = stripComments(readFileSync(file, "utf8"));
  const fileNs = fileNamespaces(src);
  const names = tFnNames(src);
  const tCall = tCallRe(names);
  const idArg = idArgRe(names);

  let m;
  while ((m = tCall.exec(src))) {
    const delim = m[1];
    const val = m[2];
    if (delim === "`" && val.includes("${")) {
      // Dynamic template: keep the static prefix (before first ${) to guard the
      // dead-key pass, but don't assert the key exists.
      recordKey(val.slice(0, val.indexOf("${")), fileNs, true);
    } else {
      recordKey(val, fileNs, false);
    }
  }

  I18NKEY_RE.lastIndex = 0;
  while ((m = I18NKEY_RE.exec(src))) recordKey(m[2], fileNs, false);

  while (idArg.exec(src)) dynamicSkipped++;
}

if (missing.length) {
  failed = true;
  // Deduplicate identical (key + candidate-set) reports.
  const seen = new Set();
  for (const { key, ns, candidates } of missing) {
    const tag = `${ns ?? candidates.join("|")}:${key}`;
    if (seen.has(tag)) continue;
    seen.add(tag);
    const where = ns ? `namespace "${ns}"` : `namespaces [${candidates.join(", ")}]`;
    console.error(`[i18n] key "${key}" used in code is missing from ${where}`);
  }
}

// Dead-key warning (non-fatal). A locale key is "covered" if it was statically
// referenced, or a static template prefix could expand to it. Heavy dynamic key
// construction makes this best-effort, hence warning-only.
function coveredByPrefix(ns, key) {
  for (const p of dynamicPrefixes) {
    if (p.prefix && key.startsWith(p.prefix)) {
      if (p.ns === null && p.candidates.has(ns)) return true;
      if (p.ns === ns) return true;
    }
  }
  return false;
}

const dead = [];
for (const ns of namespaces) {
  for (const key of new Set([...(en[ns] ?? []), ...(ru[ns] ?? [])])) {
    const base = key.replace(SUFFIX_RE, "");
    if (referenced.has(`${ns} ${key}`) || referenced.has(`${ns} ${base}`)) continue;
    if (coveredByPrefix(ns, key) || coveredByPrefix(ns, base)) continue;
    dead.push(`${ns}:${key}`);
  }
}

// Sanity: if the extractor found essentially nothing, it is broken — fail loud
// rather than silently passing a no-op gate.
const staticFound = referenced.size + missing.length;
if (staticFound === 0) {
  console.error("[i18n] code-vs-json: extracted 0 static keys — extractor likely broken");
  failed = true;
}

if (failed) process.exit(1);

console.log("[i18n] en/ru key parity OK");
console.log(
  `[i18n] code-vs-json OK — ${referenced.size} static keys resolved, ` +
    `${dynamicSkipped} dynamic key(s) skipped`,
);
if (dead.length) {
  // Quiet by default — most of these are referenced through identifier args
  // (t(finding.key)) the static extractor can't see, so a full list every build
  // is alarm fatigue. Set I18N_DEAD_KEYS=1 to audit the list.
  if (process.env.I18N_DEAD_KEYS) {
    console.log(`[i18n] warning: ${dead.length} locale key(s) with no static reference:`);
    for (const d of dead) console.log(`[i18n]   - ${d}`);
  } else {
    console.log(
      `[i18n] note: ${dead.length} locale key(s) had no static reference ` +
        `(many are resolved dynamically; run with I18N_DEAD_KEYS=1 to list)`,
    );
  }
}
