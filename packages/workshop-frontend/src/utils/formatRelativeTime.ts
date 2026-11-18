/**
 * Relative age in the compact form the activity surfaces use: "just now", "7m ago", "3h ago",
 * "2d ago". Deliberately coarse — these timestamps say how stale something is, not when it
 * happened.
 */
export function formatRelativeTime(date: Date): string {
  const minutes = Math.floor(Math.max(0, Date.now() - new Date(date).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
