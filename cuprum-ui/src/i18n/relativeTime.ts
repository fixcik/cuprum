/** A relative-time result: an i18n key (under the `project` namespace) plus
 *  optional interpolation params. The caller resolves it with `t(key, params)`. */
export interface RelativeTime {
  key: string;
  params?: { n: number };
}

/** Format a unix-seconds timestamp relative to `nowSec` (defaults to now). Buckets:
 *  <45s just now · <60m minutes · <24h hours · <48h yesterday · else days. */
export function relativeTime(tsSec: number, nowSec = Date.now() / 1000): RelativeTime {
  const diff = Math.max(0, nowSec - tsSec);
  if (diff < 45) return { key: "history.relative.justNow" };
  const min = Math.round(diff / 60);
  if (min < 60) return { key: "history.relative.minutes", params: { n: min } };
  const hours = Math.round(diff / 3600);
  if (hours < 24) return { key: "history.relative.hours", params: { n: hours } };
  const days = Math.floor(diff / 86400);
  if (days <= 1) return { key: "history.relative.yesterday" };
  return { key: "history.relative.days", params: { n: days } };
}
