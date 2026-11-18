import { describe, expect, it } from 'vitest'
import type { ManagementSchedule } from '@gadgets/gatekeeper-scheduler/src/management-types'
import type { BoundHookInfo } from '@gadgets/workshop-shared/api'
import { narrowList } from '@/components/listView'
import { automationList, needsAttention, type ListedAutomation } from './automationList'

const schedule = (more: Partial<ManagementSchedule> = {}): ManagementSchedule => ({
  scheduleId: 's', title: 't', description: 'd', workspaceId: 'w', status: 'active', cadence: { kind: 'interval', everyMs: 60_000, anchorMs: 0 }, ...more,
}) as ManagementSchedule

const automation = (id: number, title: string, more: { kind?: 'schedule' | 'event'; enabled?: boolean; schedule?: ManagementSchedule; workspaceId?: string; workspaceTitle?: string; hook?: Partial<BoundHookInfo> } = {}): ListedAutomation => {
  const { kind = 'schedule', enabled = true, workspaceId = 'w1', workspaceTitle = 'Sales', hook } = more
  return {
    key: `${workspaceId}/${id}`,
    workspaceId,
    workspaceTitle,
    kind,
    schedule: more.schedule,
    hook: { id, gatekeeperId: 1, gadgetId: 2, description: { title, description: '' }, enabled, ...hook },
  }
}

const ITEMS = [
  automation(1, 'Morning brief', { schedule: schedule({ nextFire: 3_000 }) }),
  automation(2, 'Digest', { schedule: schedule({ nextFire: 1_000 }) }),
  automation(3, 'Backup', { schedule: schedule({ status: 'dead', failedAt: 0, failureCode: 'authorization_failed' }) as ManagementSchedule }),
  automation(4, 'New email', { kind: 'event', workspaceId: 'w2', workspaceTitle: 'Inbox', hook: { resourceTitle: 'Support inbox' } }),
  automation(5, 'Weekly report', { enabled: false, workspaceId: 'w2', workspaceTitle: 'Inbox' }),
]
const spec = automationList(ITEMS)
const arranged = (order: string) =>
  spec.orders.find(({ id }) => id === order)!.arrange(ITEMS, 2).map(({ label, entries }) => [label, entries.map(({ value }) => value.hook.description.title)])
const left = (query: string, ...ids: string[]) =>
  narrowList(ITEMS, { query, searchText: spec.searchText, filters: spec.filters!.filter(({ id }) => ids.includes(id)) }).map(({ hook }) => hook.id)

describe('automationList', () => {
  it('starts with what needs seeing to, then the scheduled soonest first, then what an event sets off, then what is paused', () => {
    expect(arranged('standing')).toEqual([
      ['Needs attention', ['Backup']],
      ['Scheduled', ['Digest', 'Morning brief']],
      ['When something happens', ['New email']],
      ['Paused', ['Weekly report']],
    ])
  })

  it('groups by workspace, each in the order of how they stand', () => {
    expect(arranged('workspace')).toEqual([
      ['Inbox', ['New email', 'Weekly report']],
      ['Sales', ['Backup', 'Digest', 'Morning brief']],
    ])
  })

  it('needs seeing to when it stopped or is trying again, but not while paused', () => {
    expect(needsAttention(ITEMS[2])).toBe(true)
    expect(needsAttention(automation(9, 'Retry', { schedule: schedule({ retrying: true }) }))).toBe(true)
    expect(needsAttention(automation(9, 'Off', { enabled: false, schedule: schedule({ status: 'dead', failedAt: 0 }) as ManagementSchedule }))).toBe(false)
  })

  it('narrows to a kind, to on or paused, and to a workspace, once there is more than one', () => {
    expect(left('', 'event')).toEqual([4])
    expect(left('', 'paused')).toEqual([5])
    expect(left('', 'schedule', 'workspace:w2')).toEqual([5])
    expect(automationList(ITEMS.slice(0, 3)).filters!.filter(({ facet }) => facet === 'workspace')).toEqual([])
  })

  it('finds one by its name, what it watches, when it runs and its workspace', () => {
    expect(left('digest')).toEqual([2])
    expect(left('support')).toEqual([4])
    expect(left('every minute')).toEqual([1, 2, 3])
    expect(left('inbox')).toEqual([4, 5])
  })
})
