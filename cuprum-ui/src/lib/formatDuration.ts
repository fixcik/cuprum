/** Human-readable motion duration: `"M мин SS с"` for a minute or more, else
 *  `"S с"`. The unit abbreviations are passed in so the caller localises them
 *  (e.g. `t("preflight.minAbbr")` / `t("preflight.secAbbr")`). Seconds are padded
 *  to two digits only when minutes are shown. */
export function formatDuration(totalSec: number, minAbbr: string, secAbbr: string): string {
  const sec = Math.max(0, Math.round(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const secStr = `${String(s).padStart(m > 0 ? 2 : 1, "0")} ${secAbbr}`;
  return m > 0 ? `${m} ${minAbbr} ${secStr}` : secStr;
}
