import type { ChatTimelineHead, UnreadThread, WorkspaceSummary, WorkspaceWaitingChat } from '@gadgets/workshop-shared/api'
import { plainLine } from './activity/WorkspaceActivity'

/** A chat as the sidebar lists it among the viewer's recent ones. */
export type RecentChat = {
  workspaceId: string
  chatId: number
  key: string
  title: string
  lastActive: Date
  /** The agent it is a run of, rather than a chat people had. */
  agent?: string
  /** It waits on a person: to approve an action, or to do something else, such as connect a service. */
  waiting?: 'approval' | 'action'
  /** Its agent is at work. */
  working: boolean
  /** It has messages the viewer has not read, and they hear of it. */
  unread: boolean
  /** The viewer muted it. */
  muted: boolean
  /** What it last said or, while it waits, what it asks, with who said it where that is known. */
  latest?: { text: string; author?: ChatTimelineHead['latestAuthor'] }
}

/** How far back a chat is recent. */
export const RECENT_FOR = 7 * 24 * 60 * 60_000
// The most the sidebar lists, whatever else is recent.
const MOST = 30

export const recentChatKey = (workspaceId: string, chatId: number) => `${workspaceId}:${chatId}`

/**
 * The viewer's recent chats, across their workspaces: what waits on them (each workspace's
 * summary, `summaries` by workspace id), and the chats they take part in (the account's tracked
 * chats, `threads`, each with its latest message) active lately, all of them by when they were last
 * active, the latest first, so that what just happened in one, such as a new message, puts it at the
 * top. The viewer takes part in a chat they wrote in, have read some of, or asked to hear of. One the
 * viewer took out of the list (`hidden`, by key, at the time it was last active then) is left out
 * until it waits on a person again, after more has happened in it.
 */
export const recentChatsOf = (
  threads: Iterable<UnreadThread>,
  summaries: ReadonlyMap<string, WorkspaceSummary>,
  hidden: ReadonlyMap<string, number>,
  now: number,
): RecentChat[] => {
  const waitingByKey = new Map<string, WorkspaceWaitingChat & { workspaceId: string }>()
  const working = new Set<string>()
  for (const [workspaceId, { waitingChats = [], workingChatIds = [] }] of summaries) {
    for (const chat of waitingChats) waitingByKey.set(recentChatKey(workspaceId, chat.chatId), { ...chat, workspaceId })
    for (const chatId of workingChatIds) working.add(recentChatKey(workspaceId, chatId))
  }
  const threadByKey = new Map([...threads].map((thread) => [recentChatKey(thread.workspaceId, thread.chatId), thread]))

  const found: RecentChat[] = []
  for (const key of new Set([...waitingByKey.keys(), ...threadByKey.keys()])) {
    const thread = threadByKey.get(key)
    const waits = waitingByKey.get(key)
    const said = thread?.latestActivityAt
    const lastActive = waits && (!said || waits.lastActive > said) ? waits.lastActive : said
    if (!lastActive) continue
    const takesPart = thread !== undefined &&
      (thread.participated === true || thread.readThroughSequence >= 0 || thread.notificationsEnabledOverride === true)
    if (!waits && !(takesPart && lastActive.getTime() >= now - RECENT_FOR)) continue
    const hiddenAt = hidden.get(key)
    if (hiddenAt !== undefined && !(waits && lastActive.getTime() > hiddenAt)) continue
    const ask = waits?.ask
    found.push({
      workspaceId: (waits ?? thread)!.workspaceId,
      chatId: (waits ?? thread)!.chatId,
      key,
      title: waits?.title ?? thread!.chatTitle,
      lastActive,
      agent: waits && (waits.spawnerId !== undefined || waits.spawnerName !== undefined) ? waits.spawnerName ?? 'An agent' : undefined,
      waiting: waits?.waiting,
      working: working.has(key),
      unread: thread !== undefined && thread.unreadMessageCount > 0 && thread.notificationsEnabled !== false,
      muted: thread?.notificationsEnabledOverride === false,
      latest: ask
        ? { text: ask.type === 'connection' ? `Connect ${ask.vendorName} · ${plainLine(ask.reason)}` : ask.type === 'action' ? plainLine(ask.title) : `Fetch ${ask.url}` }
        : thread?.latestMessagePreview ? { text: plainLine(thread.latestMessagePreview), author: thread.latestAuthor } : undefined,
    })
  }
  return found
    .toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
    .slice(0, MOST)
}
