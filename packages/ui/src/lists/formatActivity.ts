const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/**
 * When something last happened, the way a list shows it: "Just now", "5 min ago", "3 hours ago",
 * "Yesterday", a weekday within the past week, otherwise a short date ("Aug 2", with the year when
 * it isn't this one).
 */
export const formatActivity = (date: Date, now: Date = new Date()): string => {
  const elapsed = now.getTime() - date.getTime()
  // Also covers a timestamp slightly ahead of this device's clock.
  if (elapsed < MINUTE) return 'Just now'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR)
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  }

  // Whole calendar days, not 24-hour spans, so late last night is "Yesterday" at breakfast.
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY)
  if (days <= 1) return 'Yesterday'
  if (days < 7) return date.toLocaleDateString('en', { weekday: 'long' })
  return date.toLocaleDateString('en', {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}
