import type { AiChatAuthorInfo, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { isAgentRun } from '@/automations/agents'
import { groupByTime } from '@/chat/timeGroups'
import type { ArrangedGroup } from '@/components/listView'
import type { ChatGrouping } from './chatList'
import type { ChatState, ChatStateKind } from './chatStates'

type Chat = AiChatMetadata

/** A workspace's chats in groups, and whether the groups are headed by their labels, which a grouping by status needs not. */
export type ChatGroups = { groups: ArrangedGroup<Chat>[]; headed: boolean }

// Most urgent first: what waits on a decision, what went wrong, what is there to look at, what is
// unread, and then the rest. What is at work is not a group of its own, as a chat would move into
// it and out again each time its agent starts and stops: it stays where it is, saying so.
const STATUS_GROUPS: Array<{ key: Exclude<ChatStateKind, 'working'> | 'unread' | 'rest'; label: string }> = [
  { key: 'approval', label: 'Needs approval' },
  { key: 'answer', label: 'Needs action' },
  { key: 'failed', label: 'Failed' },
  { key: 'review', label: 'Ready for review' },
  { key: 'unread', label: 'Unread' },
  { key: 'rest', label: 'Everything else' },
]

/** Whose a chat is, as a group of them: the viewer's, then each person's, then each agent's, then those whose starter is not known yet. */
export type ChatOwner = { key: string; label: string; rank: number }

export const ownerOf = (chat: Chat, starter: AiChatAuthorInfo | undefined, viewerId: string | undefined): ChatOwner => {
  if (isAgentRun(chat)) {
    const name = chat.spawnerName ?? 'An agent'
    return { key: `agent:${chat.spawnerId ?? name}`, label: name, rank: 2 }
  }
  if (starter?.type !== 'user') return { key: 'unknown', label: 'Someone', rank: 3 }
  if (starter.id === viewerId) return { key: `person:${starter.id}`, label: 'You', rank: 0 }
  return { key: `person:${starter.id}`, label: starter.name, rank: 1 }
}

/**
 * `chats`, in the order chosen, put in groups as `grouping` says, each keeping that order within
 * it: by how they stand, most urgent first (`STATUS_GROUPS`, unheaded, as each row's pill says
 * it); by when (`at`), in stretches of time as fine as there are `enough` chats for, as the
 * Library's are; by whose they are (`owner`); or not at all. Empty groups are left out.
 */
export const groupChats = (
  grouping: ChatGrouping,
  chats: readonly Chat[],
  { states, unread, owner, at, now = new Date(), enough = 2 }: {
    states: ReadonlyMap<number, ChatState>
    unread: (chatId: number) => boolean
    owner: (chat: Chat) => ChatOwner
    at: (chat: Chat) => Date
    now?: Date
    enough?: number
  },
): ChatGroups => {
  if (grouping === 'date') {
    const groups = groupByTime(chats.map((chat) => ({ value: chat, at: at(chat) })), now, enough)
    return { groups: groups.map(({ key, label, entries }) => ({ key, label, entries: entries.map(({ value }) => ({ value })) })), headed: true }
  }
  if (grouping === 'owner') {
    const byKey = new Map<string, { owner: ChatOwner; chats: Chat[] }>()
    for (const chat of chats) {
      const found = owner(chat)
      const group = byKey.get(found.key) ?? { owner: found, chats: [] }
      group.chats.push(chat)
      byKey.set(found.key, group)
    }
    const groups = [...byKey.values()]
      .toSorted((a, b) => a.owner.rank - b.owner.rank || a.owner.label.localeCompare(b.owner.label, 'en', { sensitivity: 'base' }))
      .map(({ owner: { key, label }, chats: within }) => ({ key, label, entries: within.map((value) => ({ value })) }))
    return { groups, headed: true }
  }
  if (grouping === 'none') return { groups: chats.length > 0 ? [{ key: 'all', label: 'Chats', entries: chats.map((value) => ({ value })) }] : [], headed: false }
  const statusOf = ({ id }: Chat) => {
    const kind = states.get(id)?.kind
    return kind !== undefined && kind !== 'working' ? kind : unread(id) ? 'unread' : 'rest'
  }
  const groups = STATUS_GROUPS
    .map(({ key, label }) => ({ key, label, entries: chats.filter((chat) => statusOf(chat) === key).map((value) => ({ value })) }))
    .filter(({ entries }) => entries.length > 0)
  return { groups, headed: false }
}

/**
 * `chats` as `arrange` groups them, with the favorites taken out and put first, in a group of their
 * own in the same order, whichever order and grouping it is.
 */
export const favoritesFirst = <T>(chats: readonly T[], favorite: (chat: T) => boolean, arrange: (chats: T[]) => ArrangedGroup<T>[]): ArrangedGroup<T>[] => {
  const favorites = arrange(chats.filter(favorite)).flatMap(({ entries }) => entries)
  const rest = arrange(chats.filter((chat) => !favorite(chat)))
  return favorites.length > 0 ? [{ key: 'favorites', label: 'Favorites', entries: favorites }, ...rest] : rest
}
