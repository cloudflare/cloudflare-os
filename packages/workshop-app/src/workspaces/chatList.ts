import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import type { ListFilter, ListOrder, ListViewSpec } from '@gadgets/ui'

type Chat = AiChatMetadata

/** What a chat is called where it is listed. */
export const chatTitle = ({ title }: { title: string }) => title || 'Untitled chat'

// Each order is one group, which the list then groups as chosen (`groupChats`), each group in it.
const flat = (id: string, label: string, compare: (a: Chat, b: Chat) => number): ListOrder<Chat> => ({
  id,
  label,
  arrange: (chats) => [{ key: id, label, entries: chats.toSorted(compare).map((value) => ({ value })) }],
})

const latest = (at: (chat: Chat) => Date) => (a: Chat, b: Chat) => at(b).getTime() - at(a).getTime()

const ORDERS: ListOrder<Chat>[] = [
  flat('active', 'Last active', latest(({ lastActive }) => lastActive)),
  flat('started', 'Date started', latest(({ started }) => started)),
  flat('name', 'Name', (a, b) => chatTitle(a).localeCompare(chatTitle(b), 'en', { sensitivity: 'base' }) || latest(({ lastActive }) => lastActive)(a, b)),
]

// Dearest first, and those that have no cost known last.
const byCost = flat('cost', 'Cost', (a, b) => (b.totalCost ?? -1) - (a.totalCost ?? -1) || b.lastActive.getTime() - a.lastActive.getTime())

/** How a workspace's chats can be grouped, each group in the order chosen: how they stand first. */
export const CHAT_GROUPINGS = [
  { id: 'status', label: 'Status' },
  { id: 'date', label: 'Date' },
  { id: 'owner', label: 'Owner' },
  { id: 'none', label: 'None' },
] as const

export type ChatGrouping = (typeof CHAT_GROUPINGS)[number]['id']

/** What else a workspace's chats can be ordered and narrowed by, where the list knows it. */
export type ChatListExtras = {
  /** Which the viewer has starred. */
  favorite?: (chat: Chat) => boolean
  /** Which the viewer started, where who started it is known. */
  mine?: (chat: Chat) => boolean
}

/**
 * How a workspace's chats can be ordered, narrowed and searched: by title, by whether it needs the
 * viewer (`needsYou`: waiting on an approval or an answer, failed, or ready for review), by whether
 * anything in one is unread (`unread`, the ids of those that have). By cost too, for `showsCost`;
 * and by what `extras` adds, the viewer's own and their favorites among it.
 */
export const chatList = (unread: ReadonlySet<number>, needsYou: (chat: Chat) => boolean, showsCost = false, extras: ChatListExtras = {}): ListViewSpec<Chat, ListOrder<Chat>> => {
  const filters: ListFilter<Chat>[] = [
    ...(extras.mine ? [{ id: 'mine', label: 'Yours', test: extras.mine }] : []),
    { id: 'needs', label: 'Action needed', test: needsYou },
    { id: 'unread', label: 'Unread', test: ({ id }) => unread.has(id) },
    ...(extras.favorite ? [{ id: 'favorites', label: 'Favorites', test: extras.favorite }] : []),
  ]
  return { orders: [...ORDERS, ...(showsCost ? [byCost] : [])], groupings: [...CHAT_GROUPINGS], filters, searchText: chatTitle }
}
