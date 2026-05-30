export function formatRelativeTime(epochSecs: number): string {
  const diffSec = Math.floor(Date.now() / 1000 - epochSecs);
  if (diffSec < 60) return "только что";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} мин назад`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} ч назад`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay} дн назад`;
  return new Date(epochSecs * 1000).toLocaleDateString();
}
