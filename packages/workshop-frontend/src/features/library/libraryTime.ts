// How the Library dates its items (Figma "MacBook Pro 14\" - 18"): hours for today, then
// "Yesterday", a weekday within the week, "Last week", and a short date beyond that.

const HOUR = 3_600_000
const DAY = 24 * HOUR

const startOfDay = (date: Date) => {
  const day = new Date(date)
  day.setHours(0, 0, 0, 0)
  return day
}

/** The Library's label for when an item was last touched, relative to `now`. */
export function libraryTimeLabel(date: Date, now = new Date()): string {
  const elapsed = now.getTime() - date.getTime()
  const days = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / DAY)
  if (days <= 0) {
    const hours = Math.floor(elapsed / HOUR)
    if (hours < 1) {
      const minutes = Math.floor(elapsed / 60_000)
      return minutes < 1 ? 'Just now' : `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`
    }
    return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  }
  if (days === 1) return 'Yesterday'
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: 'long' })
  if (days < 14) return 'Last week'
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}

/** Which of the Library's grouped cards an item falls in: this week, or before. */
export function libraryBucket(date: Date, now = new Date()): 'recent' | 'earlier' {
  const days = Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / DAY)
  return days < 7 ? 'recent' : 'earlier'
}

/**
 * How long ago a chat was last active, as a workspace's chat list shows it (Figma "8 mins ago",
 * "2 days ago"): minutes, hours, then days for a month, and a short date beyond that.
 */
export function agoLabel(date: Date, now = new Date()): string {
  const elapsed = Math.max(0, now.getTime() - date.getTime())
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'min' : 'mins'} ago`
  const hours = Math.floor(elapsed / HOUR)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(elapsed / DAY)
  if (days < 31) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
  })
}
