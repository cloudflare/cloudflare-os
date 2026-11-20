import { describe, expect, it } from 'vitest'
import type { ManagementSchedule } from '@gadgets/gatekeeper-scheduler/src/management-types'
import type { ScheduleCadence, Weekday } from '@gadgets/gatekeeper-scheduler/src/types'
import type { BoundHookInfo } from '@gadgets/workshop-shared/api'
import type { ChatItem } from '@/chat/chatItems'
import { automationsOf, hooksShownIn, setUpIn, type Automation } from './automations'
import { cadenceWords, nextWords, scheduleState, soonWords } from './cadence'

const zone = { locale: 'en-US', viewerZone: 'America/New_York' }
const weekly = (byDay: Weekday[], interval = 1): ScheduleCadence =>
  ({ kind: 'calendar', timeZone: 'America/New_York', rule: { freq: 'weekly', interval, byDay, hour: 9, minute: 0, anchorMs: 0 } })

describe('cadenceWords', () => {
  it('says an interval in its largest whole unit', () => {
    expect(cadenceWords({ kind: 'interval', everyMs: 15 * 60_000, anchorMs: 0 }, zone)).toBe('Every 15 minutes')
    expect(cadenceWords({ kind: 'interval', everyMs: 60 * 60_000, anchorMs: 0 }, zone)).toBe('Every hour')
    expect(cadenceWords({ kind: 'interval', everyMs: 2 * 24 * 60 * 60_000, anchorMs: 0 }, zone)).toBe('Every 2 days')
  })

  it('names weekdays, weekends and days the way a person would', () => {
    expect(cadenceWords(weekly(['MO', 'TU', 'WE', 'TH', 'FR']), zone)).toBe('Every weekday at 9:00 AM')
    expect(cadenceWords(weekly(['SU', 'SA']), zone)).toBe('Every weekend at 9:00 AM')
    expect(cadenceWords(weekly(['TH', 'MO']), zone)).toBe('Every Monday and Thursday at 9:00 AM')
    expect(cadenceWords(weekly(['FR'], 2), zone)).toBe('Every 2 weeks, on Friday, at 9:00 AM')
  })

  it('says daily and hourly ones, and the time zone of one kept elsewhere', () => {
    expect(cadenceWords({ kind: 'calendar', timeZone: 'America/New_York', rule: { freq: 'daily', interval: 1, hour: 17, minute: 30, anchorMs: 0 } }, zone))
      .toBe('Every day at 5:30 PM')
    expect(cadenceWords({ kind: 'calendar', timeZone: 'America/Los_Angeles', rule: { freq: 'hourly', interval: 2, minute: 15, anchorMs: 0 } }, zone))
      .toBe('Every 2 hours at 15 past, Los Angeles time')
  })

  it('says when a one-time task runs, in its own zone', () => {
    expect(cadenceWords({ kind: 'once', fireAt: Date.UTC(2026, 10, 20, 14, 0), timeZone: 'America/New_York' }, zone)).toBe('Once, on Nov 20 at 9:00 AM')
  })
})

describe('nextWords, soonWords and scheduleState', () => {
  const now = new Date(2026, 10, 14, 10, 0).getTime()

  it('says soon, today, tomorrow, this week and later differently', () => {
    expect(nextWords(now + 20_000, now, { locale: 'en-US' })).toBe('in a moment')
    expect(nextWords(now + 5 * 60_000, now, { locale: 'en-US' })).toBe('in 5 minutes')
    expect(nextWords(new Date(2026, 10, 14, 15, 0).getTime(), now, { locale: 'en-US' })).toBe('today at 3:00 PM')
    expect(nextWords(new Date(2026, 10, 15, 9, 0).getTime(), now, { locale: 'en-US' })).toBe('tomorrow at 9:00 AM')
    expect(nextWords(new Date(2026, 10, 18, 9, 0).getTime(), now, { locale: 'en-US' })).toBe('Wednesday at 9:00 AM')
    expect(nextWords(new Date(2026, 11, 2, 9, 0).getTime(), now, { locale: 'en-US' })).toBe('Dec 2 at 9:00 AM')
  })

  it('says how soon in a few words, by calendar day past today', () => {
    expect(soonWords(now + 20_000, now, { locale: 'en-US' })).toBe('now')
    expect(soonWords(now + 5 * 60_000, now, { locale: 'en-US' })).toBe('in 5 min')
    expect(soonWords(new Date(2026, 10, 14, 15, 0).getTime(), now, { locale: 'en-US' })).toBe('in 5 hr')
    // Under a day away, but tomorrow all the same.
    expect(soonWords(new Date(2026, 10, 15, 9, 0).getTime(), now, { locale: 'en-US' })).toBe('tomorrow')
    expect(soonWords(new Date(2026, 10, 18, 9, 0).getTime(), now, { locale: 'en-US' })).toBe('in 4 days')
    expect(soonWords(new Date(2026, 11, 2, 9, 0).getTime(), now, { locale: 'en-US' })).toBe('Dec 2')
  })

  it('says the next time on the schedule’s own clock when its cadence names it', () => {
    const at = Date.UTC(2026, 10, 16, 14, 0)
    const cadence = { kind: 'calendar', timeZone: 'America/New_York', rule: { freq: 'daily', interval: 1, hour: 9, minute: 0, anchorMs: 0 } } as const
    const schedule = { scheduleId: 's', title: 't', description: 'd', workspaceId: 'w', cadence, status: 'active', nextFire: at } as const
    const sunday = Date.UTC(2026, 10, 15, 18, 0)
    expect(scheduleState(schedule, sunday, { locale: 'en-US', viewerZone: 'America/Los_Angeles' })).toEqual({ next: { soon: 'tomorrow', at: 'tomorrow at 9:00 AM' } })
  })

  it('says why one stopped, and warns of a retry in place of when it runs next', () => {
    const base = { scheduleId: 's', title: 't', description: 'd', workspaceId: 'w', cadence: { kind: 'interval', everyMs: 60_000, anchorMs: 0 } } as const
    expect(scheduleState({ ...base, status: 'active', nextFire: now + 5 * 60_000, retrying: true }, now, { locale: 'en-US' }))
      .toEqual({ note: { words: 'Failed, trying again in 5 minutes', tone: 'warning' } })
    expect(scheduleState({ ...base, status: 'dead', failedAt: now, failureCode: 'authorization_failed' }, now).note?.words).toBe('Stopped: it no longer had access')
    expect(scheduleState({ ...base, status: 'completed', completedAt: now }, now).note).toEqual({ words: 'Done', tone: 'quiet' })
    expect(scheduleState({ ...base, status: 'active' }, now)).toEqual({})
  })
})

const boundHook = (id: number, more: Partial<BoundHookInfo> = {}): BoundHookInfo => ({
  id, gatekeeperId: 50, gadgetId: 2, description: { title: `Hook ${id}`, description: 'Runs.' }, enabled: true, ...more,
})
const listed = (more: Partial<ManagementSchedule>): ManagementSchedule => ({
  scheduleId: 's', title: 'Hook 1', description: 'Runs.', workspaceId: 'w', status: 'active', cadence: { kind: 'interval', everyMs: 60_000, anchorMs: 0 }, ...more,
}) as ManagementSchedule
const ids = (list: Automation[]) => list.map(({ hook }) => hook.id)
const SCHEDULED = { resourceTitle: 'Scheduled Tasks', resourceUrl: 'scheduler://tasks' }

describe('automationsOf', () => {
  it('finds each schedule by what its hook says, once, newest first, and leaves other workspaces’ alone', () => {
    const list = automationsOf('w', [boundHook(1, SCHEDULED), boundHook(3, { description: { title: 'Hook 1', description: 'Runs.' } }), boundHook(4, { gadgetId: 9 })], [
      listed({ scheduleId: 'mine' }),
      listed({ scheduleId: 'elsewhere', workspaceId: 'other', title: 'Hook 4' }),
    ])
    expect(list.map((each) => [each.hook.id, each.kind, each.schedule?.scheduleId])).toEqual([[4, 'event', undefined], [3, 'schedule', 'mine'], [1, 'schedule', undefined]])
  })

  it('matches a schedule pinned to a gadget only to that gadget’s hook', () => {
    const list = automationsOf('w', [boundHook(1), boundHook(2, { gadgetId: 5, description: { title: 'Hook 1', description: 'Runs.' } })], [listed({ gadgetId: 5 })])
    expect(list.map((each) => [each.hook.id, each.schedule?.scheduleId])).toEqual([[2, 's'], [1, undefined]])
  })

  it('is still a schedule while paused, with no schedule shown', () => {
    const [paused] = automationsOf('w', [boundHook(1, { ...SCHEDULED, enabled: false })], [listed({})])
    expect([paused.kind, paused.schedule]).toEqual(['schedule', undefined])
  })
})

const hookCard = (hookId?: number) => ({ kind: 'hook', key: `hook:${hookId}`, id: 1, hookId, title: 't', description: '', enabled: true }) as ChatItem

describe('a chat’s automations', () => {
  it('are those its cards show that were not deleted', () => {
    const shown = hooksShownIn([hookCard(3), { kind: 'divider', key: 'd' } as ChatItem, hookCard(undefined), hookCard(1)])
    expect(shown).toEqual([3, 1])
    const list = automationsOf('w', [boundHook(1), boundHook(2), boundHook(3)], [])
    expect(ids(list.filter(setUpIn(new Set(shown))))).toEqual([3, 1])
  })
})
