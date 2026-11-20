import { describe, expect, it } from 'vitest'
import type { BoundHookInfo } from '@gadgets/workshop-shared/api'
import { narrowList } from '@gadgets/ui'
import { automationList, type ListedAutomation } from './automationList'

const automation = (id: number, title: string, more: { enabled?: boolean; workspaceId?: string; workspaceTitle?: string; hook?: Partial<BoundHookInfo> } = {}): ListedAutomation => {
  const { enabled = true, workspaceId = 'w1', workspaceTitle = 'Sales', hook } = more
  return {
    key: `${workspaceId}/${id}`,
    workspaceId,
    workspaceTitle,
    hook: { id, gatekeeperId: 1, gadgetId: 2, description: { title, description: '' }, enabled, ...hook },
  }
}

const ITEMS = [
  automation(1, 'Morning brief'),
  automation(2, 'Digest'),
  automation(4, 'New email', { workspaceId: 'w2', workspaceTitle: 'Inbox', hook: { resourceTitle: 'Support inbox' } }),
  automation(5, 'Weekly report', { enabled: false, workspaceId: 'w2', workspaceTitle: 'Inbox' }),
]
const spec = automationList(ITEMS)
const arranged = (order: string) =>
  spec.orders.find(({ id }) => id === order)!.arrange(ITEMS, 2).map(({ label, entries }) => [label, entries.map(({ value }) => value.hook.description.title)])
const left = (query: string, ...ids: string[]) =>
  narrowList(ITEMS, { query, searchText: spec.searchText, filters: spec.filters!.filter(({ id }) => ids.includes(id)) }).map(({ hook }) => hook.id)

describe('automationList', () => {
  it('starts with what is on, then what is paused, each by title', () => {
    expect(arranged('standing')).toEqual([
      ['On', ['Digest', 'Morning brief', 'New email']],
      ['Paused', ['Weekly report']],
    ])
  })

  it('groups by workspace, on before paused', () => {
    expect(arranged('workspace')).toEqual([
      ['Inbox', ['New email', 'Weekly report']],
      ['Sales', ['Digest', 'Morning brief']],
    ])
  })

  it('narrows to on or paused, and to a workspace, once there is more than one', () => {
    expect(left('', 'paused')).toEqual([5])
    expect(left('', 'on', 'workspace:w2')).toEqual([4])
    expect(automationList(ITEMS.slice(0, 2)).filters!.filter(({ facet }) => facet === 'workspace')).toEqual([])
  })

  it('finds one by its name, what it watches and its workspace', () => {
    expect(left('digest')).toEqual([2])
    expect(left('support')).toEqual([4])
    expect(left('inbox')).toEqual([4, 5])
  })
})
