/** Short unit labels (resolved from i18n by the caller). */
export interface DurationLabels {
  h: string;
  m: string;
  s: string;
}

/** Compact duration from whole seconds:
 *  - <60s   → "<s> с"
 *  - <3600s → "<m> м <s> с" (drop seconds when 0)
 *  - ≥3600s → "<h> ч <m> м" (drop minutes when 0)
 *  The ≥1h branch fixes the old bug that rendered inflated minutes ("9173м 43с"). */
export function formatDuration(sec: number, L: DurationLabels): string {
  const total = Math.max(0, Math.round(sec));
  if (total < 60) return `${total} ${L.s}`;
  if (total < 3600) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m} ${L.m} ${s} ${L.s}` : `${m} ${L.m}`;
  }
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return m ? `${h} ${L.h} ${m} ${L.m}` : `${h} ${L.h}`;
}

/** Calendar-day distance (local midnight to local midnight). Today=0, yesterday=1. */
export function dayBucket(tsSec: number, nowSec = Date.now() / 1000): { days: number } {
  const midnight = (s: number) => {
    const d = new Date(s * 1000);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((midnight(nowSec) - midnight(tsSec)) / 86_400_000);
  return { days: Math.max(0, days) };
}
