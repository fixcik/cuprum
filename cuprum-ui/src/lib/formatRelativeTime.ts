/** Localized relative time. Pass the active i18n language (e.g. i18n.language). */
export function formatRelativeTime(epochSecs: number, locale: string): string {
  const diffSec = Math.floor(Date.now() / 1000 - epochSecs);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (diffSec < 60) return rtf.format(0, "second");
  const min = Math.floor(diffSec / 60);
  if (min < 60) return rtf.format(-min, "minute");
  const hr = Math.floor(min / 60);
  if (hr < 24) return rtf.format(-hr, "hour");
  const day = Math.floor(hr / 24);
  if (day < 7) return rtf.format(-day, "day");
  return new Date(epochSecs * 1000).toLocaleDateString(locale);
}
