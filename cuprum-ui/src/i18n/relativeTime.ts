/** A relative-time result: an i18n key (under the `project` namespace) plus
 *  optional interpolation params. The caller resolves it with `t(key, params)`. */
export interface RelativeTime {
  key: string;
  params?: { n: number };
}

/** Format a unix-seconds timestamp relative to `nowSec` (defaults to now). Buckets
 *  keyed on the raw diff (not a rounded value, so 23.5–24h can't slip into
 *  "yesterday"): <45s just now · <1h minutes · <24h hours · <48h yesterday · else
 *  days. */
export function relativeTime(tsSec: number, nowSec = Date.now() / 1000): RelativeTime {
  const diff = Math.max(0, nowSec - tsSec);
  if (diff < 45) return { key: "history.relative.justNow" };
  if (diff < 3600)
    return { key: "history.relative.minutes", params: { n: Math.min(59, Math.round(diff / 60)) } };
  if (diff < 86400)
    return { key: "history.relative.hours", params: { n: Math.floor(diff / 3600) } };
  if (diff < 172800) return { key: "history.relative.yesterday" };
  return { key: "history.relative.days", params: { n: Math.floor(diff / 86400) } };
}
