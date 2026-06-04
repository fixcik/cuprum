import type { CapabilityProfile } from "@/lib/capabilityProfile";

/**
 * Stable, non-cryptographic fingerprint of a CapabilityProfile. Used to detect
 * whether a cached panel verdict was computed with the same capability settings
 * as the current profile. Two profiles with identical field values produce the
 * same hash; any change to any field produces a different hash. Key order does
 * not affect the result.
 *
 * Algorithm: djb2 over the JSON of the profile with sorted keys (stable across
 * JS engine versions because we control the serialisation).
 */
export function profileHash(p: CapabilityProfile): string {
  const stable = sortedJson(p);
  return djb2(stable).toString(36); // base-36 string, compact and URL-safe
}

// ---- internals ----

/** Recursively serialise any JSON-compatible value with sorted object keys. */
function sortedJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(sortedJson).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + sortedJson((value as Record<string, unknown>)[k]));
  return "{" + pairs.join(",") + "}";
}

/** djb2 hash: a fast, simple non-cryptographic 32-bit hash (unsigned). */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    // (h * 33) ^ char — keep in 32-bit unsigned range via >>> 0
    h = (((h << 5) + h) ^ s.charCodeAt(i)) >>> 0;
  }
  return h;
}
