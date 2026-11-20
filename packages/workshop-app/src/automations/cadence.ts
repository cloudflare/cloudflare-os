import type { ManagementSchedule } from '@gadgets/gatekeeper-scheduler/src/management-types'
import type { ScheduleCadence, Weekday } from '@gadgets/gatekeeper-scheduler/src/types'

// Monday first, as a week is read.
const DAYS: Array<[Weekday, string]> = [
  ['MO', 'Monday'], ['TU', 'Tuesday'], ['WE', 'Wednesday'], ['TH', 'Thursday'], ['FR', 'Friday'], ['SA', 'Saturday'], ['SU', 'Sunday'],
]
const WEEKDAYS = 'MO,TU,WE,TH,FR'
const WEEKEND = 'SA,SU'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const plural = (count: number, unit: string) => (count === 1 ? unit : `${count} ${unit}s`)

/** The time of day as the viewer writes it ("9:00 AM", or "09:00"). */
const clock = (hour: number, minute: number, locale?: string) =>
  new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(Date.UTC(2020, 0, 1, hour, minute))

/** The viewer's own time zone. */
const here = () => new Intl.DateTimeFormat().resolvedOptions().timeZone

/** " in Chicago time", for a schedule kept in a time zone other than the viewer's. */
const zoneWords = (timeZone: string, viewerZone: string) => {
  if (timeZone === viewerZone || timeZone === 'UTC' || timeZone === 'Etc/UTC') return ''
  const city = timeZone.split('/').at(-1)?.replaceAll('_', ' ')
  return city ? `, ${city} time` : ''
}

/**
 * When a schedule runs, in words: "Every weekday at 9:00 AM", "Every 15 minutes", "Every Monday and
 * Thursday at 8:30 AM", "Once, on Nov 20 at 9:00 AM". A wall-clock schedule kept in another time
 * zone than the viewer's says which ("…, Chicago time").
 */
export const cadenceWords = (cadence: ScheduleCadence, { locale, viewerZone = here() }: { locale?: string; viewerZone?: string } = {}): string => {
  if (cadence.kind === 'interval') {
    const everyMs = cadence.everyMs
    const [size, unit] = everyMs % DAY === 0 ? [DAY, 'day'] : everyMs % HOUR === 0 ? [HOUR, 'hour'] : [MINUTE, 'minute']
    return `Every ${plural(Math.max(1, Math.round(everyMs / size)), unit)}`
  }
  if (cadence.kind === 'once') {
    const date = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: cadence.timeZone }).format(cadence.fireAt)
    const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: cadence.timeZone }).format(cadence.fireAt)
    return `Once, on ${date} at ${time}${zoneWords(cadence.timeZone, viewerZone)}`
  }
  const { rule, timeZone } = cadence
  const zone = zoneWords(timeZone, viewerZone)
  if (rule.freq === 'hourly') {
    const past = rule.minute === 0 ? '' : ` at ${rule.minute} past`
    return `Every ${plural(rule.interval, 'hour')}${past}${zone}`
  }
  const time = clock(rule.hour, rule.minute, locale)
  if (rule.freq === 'daily') return `Every ${rule.interval === 1 ? 'day' : `${rule.interval} days`} at ${time}${zone}`
  const days = DAYS.filter(([day]) => rule.byDay.includes(day))
  const which = days.map(([day]) => day).join(',')
  const named = which === WEEKDAYS ? 'weekday' : which === WEEKEND ? 'weekend' : days.length === 7 ? 'day' : new Intl.ListFormat(locale ?? 'en', { type: 'conjunction' }).format(days.map(([, name]) => name))
  return rule.interval === 1
    ? `Every ${named} at ${time}${zone}`
    : `Every ${rule.interval} weeks, on ${named === 'weekday' ? 'weekdays' : named === 'weekend' ? 'weekends' : named}, at ${time}${zone}`
}

/** The calendar day `time` falls on in `timeZone` (the viewer's when absent), as days since 1970. */
const dayOf = (time: number, timeZone?: string) => {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone })
    .format(time).split('-').map(Number)
  return Date.UTC(year, month - 1, day) / DAY
}

/**
 * When something comes next, in words: "in 5 minutes", "today at 3:00 PM", "tomorrow at 9:00 AM",
 * "Friday at 9:00 AM" (this week), "Nov 20 at 9:00 AM" (later). On the clock of `timeZone`, a
 * schedule's own, so that it agrees with how its cadence is said; the viewer's when absent.
 */
export const nextWords = (at: number, now: number, { locale, timeZone }: { locale?: string; timeZone?: string } = {}): string => {
  const until = at - now
  if (until < MINUTE) return 'in a moment'
  if (until < HOUR) return `in ${plural(Math.round(until / MINUTE), 'minute')}`
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(at)
  const days = dayOf(at, timeZone) - dayOf(now, timeZone)
  if (days === 0) return `today at ${time}`
  if (days === 1) return `tomorrow at ${time}`
  if (days < 7) return `${new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone }).format(at)} at ${time}`
  return `${new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone }).format(at)} at ${time}`
}

/**
 * How soon something comes, in as few words as a list's end has room for: "now", "in 5 min",
 * "in 3 hr", "tomorrow", "in 4 days", "Dec 2". By calendar days on the clock of `timeZone`.
 */
export const soonWords = (at: number, now: number, { locale, timeZone }: { locale?: string; timeZone?: string } = {}): string => {
  const until = at - now
  if (until < MINUTE) return 'now'
  if (until < HOUR) return `in ${Math.round(until / MINUTE)} min`
  const days = dayOf(at, timeZone) - dayOf(now, timeZone)
  if (days === 0) return `in ${Math.max(1, Math.round(until / HOUR))} hr`
  if (days === 1) return 'tomorrow'
  if (days < 7) return `in ${days} days`
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone }).format(at)
}

/** How a schedule stands: when it runs next while on course, or else what there is to know of it. */
export type ScheduleState = {
  /** When it runs next, how soon ("in 3 days") and when exactly ("Monday at 8:00 AM"). */
  next?: { soon: string; at: string }
  /** Said in place of when it runs: why it stopped, that it is trying again, or that it is done. */
  note?: { words: string; tone: 'quiet' | 'warning' }
}

/**
 * How a schedule stands (`ScheduleState`): when it runs next, or that it is trying again after a
 * failure, why it stopped, that it is done or that its time passed. Nothing for a running one with
 * no time known yet.
 */
export const scheduleState = (
  schedule: ManagementSchedule,
  now: number,
  { locale, viewerZone = here() }: { locale?: string; viewerZone?: string } = {},
): ScheduleState => {
  switch (schedule.status) {
    case 'active': {
      if (schedule.nextFire === undefined) return {}
      // On the schedule's own clock when its cadence says it is kept on one other than the viewer's.
      const kept = schedule.cadence.kind === 'interval' ? undefined : schedule.cadence.timeZone
      const timeZone = kept && zoneWords(kept, viewerZone) ? kept : undefined
      const at = nextWords(schedule.nextFire, now, { locale, timeZone })
      return schedule.retrying
        ? { note: { words: `Failed, trying again ${at}`, tone: 'warning' } }
        : { next: { soon: soonWords(schedule.nextFire, now, { locale, timeZone }), at } }
    }
    case 'dead':
      return {
        note: {
          words: schedule.failureCode === 'authorization_failed' ? 'Stopped: it no longer had access' : 'Stopped: it kept failing',
          tone: 'warning',
        },
      }
    case 'completed':
      return { note: { words: 'Done', tone: 'quiet' } }
    case 'expired':
      return { note: { words: 'Its time passed while it was off', tone: 'quiet' } }
  }
}
