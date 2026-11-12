import { formatActivity } from '@/workspaces/formatActivity'

/** A stretch of time that things are listed under, nearest first. */
export type TimeGroup<T> = {
  key: string
  /** What stretch it is: "Today", "Since Monday", "October", "August – October". */
  label: string
  /** Latest first, each with when it was, which reads on its own: the group's label need not be shown. */
  entries: Array<{ value: T; at?: Date; time?: string }>
}

// A stretch with fewer than this many is folded into the one before it.
const ENOUGH = 2

const DAY = 24 * 60 * 60 * 1000
// The past week is told apart by day, and anything older by month.
const DAYS = 7

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate())

/** Whole calendar days from `date` to `now`, so that late last night is yesterday at breakfast. */
const daysBefore = (date: Date, now: Date) => Math.round((startOfDay(now).getTime() - startOfDay(date).getTime()) / DAY)

const daysAgo = (days: number, now: Date) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - days)

/** The finest stretch something is in: one of the past week's days, or a month. */
type Bucket =
  | { kind: 'day'; days: number }
  | { kind: 'month'; year: number; month: number }

const bucketOf = (at: Date | undefined, now: Date): Bucket => {
  const days = at === undefined ? 0 : Math.max(0, daysBefore(at, now))
  return days < DAYS || at === undefined ? { kind: 'day', days } : { kind: 'month', year: at.getFullYear(), month: at.getMonth() }
}

// Larger is longer ago.
const age = (bucket: Bucket, now: Date) =>
  bucket.kind === 'day' ? bucket.days : DAYS + (now.getFullYear() - bucket.year) * 12 + now.getMonth() - bucket.month

const weekday = (days: number, now: Date) => daysAgo(days, now).toLocaleDateString('en', { weekday: 'long' })
const dayName = (days: number, now: Date) => (days === 0 ? 'Today' : days === 1 ? 'Yesterday' : weekday(days, now))

const monthName = (year: number, month: number, now: Date, withYear = year !== now.getFullYear()) =>
  new Date(year, month).toLocaleDateString('en', { month: 'long', ...(withYear ? { year: 'numeric' } : {}) })

const monthOf = (bucket: Bucket, now: Date) => {
  const date = bucket.kind === 'day' ? daysAgo(bucket.days, now) : new Date(bucket.year, bucket.month)
  return { year: date.getFullYear(), month: date.getMonth() }
}

/** What a stretch from `newest` back to `oldest` is called. */
const labelOf = (newest: Bucket, oldest: Bucket, now: Date) => {
  if (newest.kind === 'day' && oldest.kind === 'day') {
    if (newest.days === oldest.days) return dayName(newest.days, now)
    if (newest.days === 0) return oldest.days === 1 ? 'Today and yesterday' : `Since ${weekday(oldest.days, now)}`
    return `${weekday(oldest.days, now)} to ${newest.days === 1 ? 'yesterday' : weekday(newest.days, now)}`
  }
  const from = monthOf(oldest, now)
  const to = monthOf(newest, now)
  if (from.year === to.year && from.month === to.month) return monthName(from.year, from.month, now)
  // Both with their year, unless both are this year's.
  const withYear = from.year !== now.getFullYear() || to.year !== now.getFullYear()
  return `${monthName(from.year, from.month, now, withYear)} – ${monthName(to.year, to.month, now, withYear)}`
}

/**
 * `entries` (latest first) put into stretches of time as fine as there are enough of them for:
 * each of the past week's days, then each month, with a stretch that has too few folded into the
 * one before it, and so on until there are enough. A busy day is a group of its own, and a quiet
 * month is gathered up with what came before it. One with no time is taken to be from now.
 */
export const groupByTime = <T>(entries: Array<{ value: T; at?: Date }>, now: Date = new Date()): TimeGroup<T>[] => {
  const buckets = new Map<number, { bucket: Bucket; entries: Array<{ value: T; at?: Date }> }>()
  for (const entry of entries) {
    const bucket = bucketOf(entry.at, now)
    const key = age(bucket, now)
    const found = buckets.get(key) ?? { bucket, entries: [] }
    found.entries.push(entry)
    buckets.set(key, found)
  }

  const groups: TimeGroup<T>[] = []
  let pending: Array<{ bucket: Bucket; entries: Array<{ value: T; at?: Date }> }> = []
  const close = () => {
    const newest = pending[0].bucket
    const oldest = pending.at(-1)!.bucket
    const timeOf = (at: Date | undefined) => (at === undefined ? undefined : formatActivity(at, now))
    groups.push({
      key: `${age(newest, now)}-${age(oldest, now)}`,
      label: labelOf(newest, oldest, now),
      entries: pending.flatMap(({ entries: within }) => within.map((entry) => ({ ...entry, time: timeOf(entry.at) }))),
    })
    pending = []
  }
  for (const [, found] of [...buckets].toSorted(([a], [b]) => a - b)) {
    pending.push(found)
    if (pending.reduce((count, { entries: within }) => count + within.length, 0) >= ENOUGH) close()
  }
  // What is left is the oldest, and stays apart rather than blur the stretch before it.
  if (pending.length > 0) close()
  return groups
}
