import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import type { ListFilter, ListOrder } from '@/components/listView'
import type { ListViewSpec } from '@/hooks/useListView'
import { formatActivity } from '../formatActivity'
import { activityStatus, activityTime, activityTitle, deciderOf, outcomeOf } from './activityEntries'

/** One entry of a workspace's activity, with the title of the chat it was in where that is known. */
export type ActivityItem = { entry: ActionLogEntry; chat?: { id: number; title: string } }

const KINDS: Array<{ type: ActionLogEntry['type']; label: string }> = [
  { type: 'action', label: 'Approvals' },
  { type: 'observation', label: 'Data read' },
  { type: 'bindHook', label: 'Automations' },
]

const OUTCOMES = [
  { id: 'waiting', label: 'Waiting' },
  { id: 'approved', label: 'Approved by a person' },
  { id: 'auto', label: 'Auto-approved' },
  { id: 'denied', label: 'Denied' },
] as const

/** Latest first, in one list, each with when it was as a list says it. */
const byTime: ListOrder<ActivityItem> = {
  id: 'time',
  label: 'Latest first',
  arrange: (items) => {
    const now = new Date()
    const entries = items
      .map((item) => ({ value: item, at: activityTime(item.entry) }))
      .toSorted((a, b) => b.at.getTime() - a.at.getTime() || b.value.entry.id - a.value.entry.id)
      .map(({ value, at }) => ({ value, time: formatActivity(at, now) }))
    return entries.length === 0 ? [] : [{ key: 'all', label: 'Activity', entries }]
  },
}

/**
 * How a workspace's activity can be narrowed and searched: by kind (approvals, what was read,
 * automations), by how an approval went, by who decided it and by the chat it was asked for in
 * (each a menu of its own, of those the items loaded name), and by what it says, where, and who.
 * It has the one order, latest first, by when each last changed.
 */
export const activityList = (items: readonly ActivityItem[], viewerId?: string): ListViewSpec<ActivityItem, ListOrder<ActivityItem>> => {
  const people = new Map<string, string>()
  const chats = new Map<number, string>()
  for (const { entry, chat } of items) {
    const decider = deciderOf(entry)
    if (decider) people.set(decider.id, decider.type === 'user' && decider.id === viewerId ? 'You' : decider.name)
    if (chat) chats.set(chat.id, chat.title)
  }
  const filters: ListFilter<ActivityItem>[] = [
    ...KINDS.map(({ type, label }): ListFilter<ActivityItem> => ({ id: `kind:${type}`, label, facet: 'kind', test: ({ entry }) => entry.type === type })),
    ...OUTCOMES.map(({ id, label }): ListFilter<ActivityItem> => ({ id: `outcome:${id}`, label, facet: 'outcome', test: ({ entry }) => outcomeOf(entry) === id })),
    ...[...people].toSorted(([, a], [, b]) => a.localeCompare(b)).map(([id, name]): ListFilter<ActivityItem> => ({
      id: `person:${id}`,
      label: name,
      facet: 'person',
      test: ({ entry }) => deciderOf(entry)?.id === id,
    })),
    ...[...chats].toSorted(([, a], [, b]) => a.localeCompare(b)).map(([id, title]): ListFilter<ActivityItem> => ({
      id: `chat:${id}`,
      label: title,
      facet: 'chat',
      test: ({ chat }) => chat?.id === id,
    })),
  ]
  return {
    orders: [byTime],
    filters,
    facetMenus: { person: 'Decided by', chat: 'Chat' },
    searchText: ({ entry, chat }) =>
      [activityTitle(entry), entry.resourceTitle, entry.description.description, chat?.title, activityStatus(entry, viewerId), deciderOf(entry)?.name].filter(Boolean).join(' '),
  }
}
