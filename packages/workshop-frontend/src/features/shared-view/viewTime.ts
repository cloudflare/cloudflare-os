import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'

/** A view this old gets the amber age chip. */
export const STALE_VIEW_DAYS = 14

const DAY_MS = 24 * 60 * 60 * 1000

const startOfDay = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).valueOf()

const clock = (date: Date): string =>
  date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

const monthDay = (date: Date): string =>
  date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

/**
 * When a view was taken, in the viewer's timezone, aging in place: "today, 10:42", then
 * "yesterday, 10:42", then "Oct 16". `separator` joins day and time (", " or " at ").
 */
export const viewMoment = (takenAt: Date, now: Date = new Date(), separator = ', '): string => {
  const days = Math.round((startOfDay(now) - startOfDay(takenAt)) / DAY_MS)
  if (days <= 0) return `today${separator}${clock(takenAt)}`
  if (days === 1) return `yesterday${separator}${clock(takenAt)}`
  return monthDay(takenAt)
}

/** The full timestamp, for a tooltip under the aged moment. */
export const viewTimestamp = (takenAt: Date): string =>
  takenAt.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' })

/** "Nov 6, 10:42": the moment as assistive tech hears it, never relative. */
export const viewStill = (takenAt: Date): string => `${monthDay(takenAt)}, ${clock(takenAt)}`

/** "3 weeks old" once a view is STALE_VIEW_DAYS old; null before. */
export const viewAgeLabel = (takenAt: Date, now: Date = new Date()): string | null => {
  const days = Math.floor((now.valueOf() - takenAt.valueOf()) / DAY_MS)
  if (days < STALE_VIEW_DAYS) return null
  return `${Math.floor(days / 7)} weeks old`
}

/** The name viewer-side copy uses for the owner: their first name, else their email. */
export const ownerFirstName = (owner: AiChatAuthorInfo): string =>
  owner.name.trim().split(/\s+/)[0] || owner.id
