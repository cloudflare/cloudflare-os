/**
 * How long ago a timestamp was, as a short phrase: `just now` under 45 seconds, then minutes (`3
 * min ago`), hours (`2 h ago`), days (`5 d ago`), and the locale's date from 30 days on. A
 * timestamp in the future reads as `just now`.
 */
export function relativeTime(epochMs: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - epochMs) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(epochMs).toLocaleDateString();
}
