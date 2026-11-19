import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import { groupByTime } from '@/chat/timeGroups'
import type { ListFilter, ListOrder } from '@/components/listView'
import { groupByName } from '@/components/nameGroups'
import type { ListViewSpec } from '@/hooks/useListView'

type Chat = AiChatMetadata

/** What a chat is called where it is listed. */
export const chatTitle = ({ title }: { title: string }) => title || 'Untitled chat'

/** Latest first, in stretches of time as fine as there are enough chats for. */
const byTime = (id: string, label: string, at: (chat: Chat) => Date): ListOrder<Chat> => ({
  id,
  label,
  arrange: (chats, enough) =>
    groupByTime(chats.toSorted((a, b) => at(b).getTime() - at(a).getTime()).map((chat) => ({ value: chat, at: at(chat) })), new Date(), enough),
})

const ORDERS: ListOrder<Chat>[] = [
  byTime('active', 'Last active', ({ lastActive }) => lastActive),
  byTime('started', 'Date started', ({ started }) => started),
  { id: 'name', label: 'Name', arrange: (chats, enough) => groupByName(chats, chatTitle, enough) },
]

/** Dearest first, in the one group, and those that have no cost known last. */
const byCost: ListOrder<Chat> = {
  id: 'cost',
  label: 'Cost',
  arrange: (chats) => [{
    key: 'cost',
    label: 'Most expensive first',
    entries: chats.toSorted((a, b) => (b.totalCost ?? -1) - (a.totalCost ?? -1) || b.lastActive.getTime() - a.lastActive.getTime()).map((value) => ({ value })),
  }],
}

/**
 * How a workspace's chats can be ordered, narrowed and searched: by title, by whether anything in
 * one is unread (`unread`, the ids of those that have), and by whether it is waiting on the viewer
 * (`waiting`, the ids of those that are). By cost too, for `showsCost`.
 */
export const chatList = (unread: ReadonlySet<number>, waiting: (chat: Chat) => boolean, showsCost = false): ListViewSpec<Chat, ListOrder<Chat>> => {
  const filters: ListFilter<Chat>[] = [
    { id: 'unread', label: 'Unread', test: ({ id }) => unread.has(id) },
    { id: 'waiting', label: 'Waiting on you', test: waiting },
  ]
  return { orders: showsCost ? [...ORDERS, byCost] : ORDERS, filters, searchText: chatTitle }
}
