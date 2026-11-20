import { describe, expect, it } from 'vitest'
import type { ActionLogEntry, AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { narrowList } from '@/components/listView'
import { activityStatus, outcomeOf } from './activityEntries'
import { activityList, type ActivityItem } from './activityList'

const now = new Date()
const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000)
const ada: AiChatAuthorInfo = { type: 'user', id: 'ada', name: 'Ada' }
const me: AiChatAuthorInfo = { type: 'user', id: 'me', name: 'Grace' }

const action = (id: number, more: Record<string, unknown> = {}): ActionLogEntry => ({
  id,
  type: 'action',
  resourceTitle: 'Repo',
  createdAt: minutesAgo(id),
  state: 'pending',
  description: { title: `Action ${id}`, description: '', implementsRevert: false, autoApprovable: true },
  ...more,
}) as ActionLogEntry
const read: ActionLogEntry = { id: 50, type: 'observation', resourceTitle: 'Sheet', createdAt: minutesAgo(3), state: 'approved', description: { title: 'Budget', description: '' } }
const hook: ActionLogEntry = { id: 51, type: 'bindHook', resourceTitle: 'Mondays', createdAt: minutesAgo(4), state: 'approved', enabled: false, hookId: 2, description: { title: 'Digest', description: '' } }

const items: ActivityItem[] = [
  { entry: action(1), chat: { id: 7, title: 'Deploy fix' } },
  { entry: action(2, { state: 'approved', resolvedBy: ada, appliedAt: minutesAgo(1) }), chat: { id: 8, title: 'Planning' } },
  { entry: action(3, { state: 'approved', autoApproved: true, resolvedBy: me }) },
  { entry: action(4, { state: 'rejected', resolvedBy: me }) },
  { entry: read },
  { entry: hook },
]

const narrowed = (on: string[], query = '') => {
  const spec = activityList(items, 'me')
  return narrowList(items, { query, searchText: spec.searchText, filters: (spec.filters ?? []).filter(({ id }) => on.includes(id)) }).map(({ entry }) => entry.id)
}

describe('activity entries', () => {
  it('says what became of each, the viewer as you', () => {
    expect(items.map(({ entry }) => [outcomeOf(entry), activityStatus(entry, 'me')])).toEqual([
      ['waiting', 'Waiting'],
      ['approved', 'Approved by Ada'],
      ['auto', 'Auto-approved by your rule'],
      ['denied', 'Denied by you'],
      ['read', 'Read'],
      ['automation', 'Automation paused'],
    ])
  })
})

describe('activityList', () => {
  it('narrows by kind and by how an approval went, alternatives within one and both together', () => {
    expect(narrowed(['kind:observation', 'kind:bindHook'])).toEqual([50, 51])
    expect(narrowed(['outcome:approved', 'outcome:denied'])).toEqual([2, 4])
    expect(narrowed(['kind:action', 'outcome:auto'])).toEqual([3])
  })

  it('offers who decided and the chats, as those loaded name them, a rule’s owner being no one who decided', () => {
    const spec = activityList(items, 'me')
    expect(spec.filters?.filter(({ facet }) => facet === 'person' || facet === 'chat').map(({ id, label }) => [id, label])).toEqual([
      ['person:ada', 'Ada'],
      ['person:me', 'You'],
      ['chat:7', 'Deploy fix'],
      ['chat:8', 'Planning'],
    ])
    expect(narrowed(['person:me'])).toEqual([4])
    expect(narrowed(['chat:8'])).toEqual([2])
  })

  it('finds an entry by what it is, where it was, and who decided it', () => {
    expect(narrowed([], 'deploy')).toEqual([1])
    expect(narrowed([], 'ada')).toEqual([2])
    expect(narrowed([], 'sheet')).toEqual([50])
  })

  it('lists the latest change first, in one list, each saying when', () => {
    const spec = activityList(items, 'me')
    const groups = spec.orders[0].arrange(items, 2)
    expect(groups).toHaveLength(1)
    expect(groups[0].entries.map(({ value }) => value.entry.id)).toEqual([2, 1, 50, 3, 51, 4])
    expect(groups[0].entries[0].time).toBe('1 min ago')
  })
})
