import type { AiChatMessage, AiChatMetadata, ChatReadState } from '@gadgets/workshop-shared/api'
import { isAgentRun } from '@/automations/agents'
import { askOf, latestOf, type LatestMessage } from './activity/WorkspaceActivity'

/** What one workspace said of its chats when the sidebar last asked it. */
export type WorkspaceChatsReading = {
  chats: readonly AiChatMetadata[]
  /** The viewer's read state for its chats (`getWorkspaceUnreadState`), which says which they have opened and muted. */
  readStates: readonly ChatReadState[]
  /** The chats with an action of their own waiting to be approved. */
  approvals: ReadonlySet<number>
}

/** What a chat's last messages said, read for the chat as it was at `lastActive`. */
export type ChatTail = {
  lastActive: number
  /** What it last said, with words in it. */
  latest?: LatestMessage
  /** What it asks of a person while it waits, where nothing was said after it. */
  ask?: LatestMessage
  /** The viewer wrote one of them. */
  wrote: boolean
}

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
  /** What it last said or, while it waits, what it asks, with who said it. */
  latest?: LatestMessage
}

/** How far back a chat is recent, as the sidebar's sweep asks only the workspaces active this lately. */
export const RECENT_FOR = 7 * 24 * 60 * 60_000
/** How many of a workspace's latest chats people had are read for what they last said and who wrote. */
export const TAILS_PER_WORKSPACE = 6
/** How many of a chat's last messages are read. */
export const TAIL_LENGTH = 20
// The most the sidebar lists, whatever else is recent.
const MOST = 30

export const recentChatKey = (workspaceId: string, chatId: number) => `${workspaceId}:${chatId}`

const waitingOn = (chat: AiChatMetadata, approvals: ReadonlySet<number>): RecentChat['waiting'] =>
  approvals.has(chat.id) ? 'approval' : chat.awaitingDecision ? 'action' : undefined

/**
 * Which chats' last messages are worth reading for the sidebar: whatever waits on a person, and
 * the latest few people had, active lately, whoever they are by, since nothing else says who wrote
 * in one.
 */
export const tailsWanted = ({ chats, approvals }: WorkspaceChatsReading, now: number): AiChatMetadata[] => {
  const latest = chats
    .filter((chat) => !isAgentRun(chat) && chat.lastActive.getTime() >= now - RECENT_FOR)
    .toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
    .slice(0, TAILS_PER_WORKSPACE)
  const waiting = chats.filter((chat) => waitingOn(chat, approvals) !== undefined && !latest.includes(chat))
  return [...latest, ...waiting]
}

/** What a chat's last messages say, for the chat as it was at `lastActive`. */
export const tailOf = (messages: readonly AiChatMessage[], lastActive: Date, viewerId: string): ChatTail => {
  const latest = messages.map(latestOf).findLast((each) => each !== undefined)
  const ask = messages.map(askOf).findLast((each) => each !== undefined)
  const wrote = messages.some((message) => (message.type === 'message' || message.type === 'slashCommand') && message.author.type === 'user' && message.author.id === viewerId)
  return { lastActive: lastActive.getTime(), latest, ask, wrote }
}

/**
 * Whether the viewer takes part in a chat: they have read some of it, wrote in it, or asked to hear
 * of it. A new chat's notifications go on as someone first writes in it, so they say it too where
 * they started off.
 */
const takesPart = (chat: AiChatMetadata, state: ChatReadState | undefined, tail: ChatTail | undefined) =>
  tail?.wrote === true ||
  (state !== undefined &&
    (state.readThroughSequence >= 0 || state.notificationsEnabledOverride === true || (chat.notificationsRequireParticipation === true && state.notificationsEnabled === true)))

/**
 * The viewer's recent chats, across the workspaces read (`readings`, by id): what waits on a
 * person, first, then the chats people had that the viewer takes part in, active lately, each
 * group the latest first. An agent's run is only listed while it waits. One the viewer took out
 * of the list (`hidden`, by key, at the time it was last active then) is left out until it waits
 * on a person again, after more has happened in it.
 */
export const recentChatsOf = (
  readings: ReadonlyMap<string, WorkspaceChatsReading>,
  tails: ReadonlyMap<string, ChatTail>,
  hidden: ReadonlyMap<string, number>,
  now: number,
): RecentChat[] => {
  const found: RecentChat[] = []
  for (const [workspaceId, { chats, readStates, approvals }] of readings) {
    const states = new Map(readStates.map((state) => [state.chatId, state]))
    for (const chat of chats) {
      const key = recentChatKey(workspaceId, chat.id)
      const state = states.get(chat.id)
      const tail = tails.get(key)
      const waiting = waitingOn(chat, approvals)
      const agentRun = isAgentRun(chat)
      const recent = chat.lastActive.getTime() >= now - RECENT_FOR
      if (waiting === undefined && (agentRun || !recent || !takesPart(chat, state, tail))) continue
      const hiddenAt = hidden.get(key)
      if (hiddenAt !== undefined && !(waiting !== undefined && chat.lastActive.getTime() > hiddenAt)) continue
      // What it last said is only for the chat as it was when read.
      const said = tail?.lastActive === chat.lastActive.getTime() ? tail : undefined
      found.push({
        workspaceId,
        chatId: chat.id,
        key,
        title: chat.title,
        lastActive: chat.lastActive,
        agent: agentRun ? chat.spawnerName ?? 'An agent' : undefined,
        waiting,
        working: chat.activeAgent !== undefined,
        unread: state !== undefined && state.unreadMessageCount > 0 && state.notificationsEnabled !== false,
        muted: state?.notificationsEnabledOverride === false,
        latest: (waiting !== undefined ? said?.ask : undefined) ?? said?.latest,
      })
    }
  }
  return found
    .toSorted((a, b) => Number(b.waiting !== undefined) - Number(a.waiting !== undefined) || b.lastActive.getTime() - a.lastActive.getTime())
    .slice(0, MOST)
}
