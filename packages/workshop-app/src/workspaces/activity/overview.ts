import { isAgentRun, type AiChatAuthorInfo, type AiChatMetadata } from '@gadgets/workshop-shared/api'
import { chatTitle } from '../chatList'
import type { ActionEntry } from './activityEntries'

/** Where something waiting was asked for: a chat a person had, an agent's run, or no chat at all. */
export type AttentionPlace =
  | { kind: 'chat'; chatId: number; title: string }
  | { kind: 'run'; chatId: number; title: string; agent: string }
  | { kind: 'elsewhere' }

/**
 * What waits on a decision in one place: the actions asked for there, oldest first, or, for a chat
 * stopped on a decision no action says (a connection, a fetch), none.
 */
export type AttentionGroup = {
  key: string
  place: AttentionPlace
  /** The chat's turn is stopped until it is decided. */
  blocking: boolean
  /** When the oldest of it was asked for. */
  since: Date
  /** The person whose request the agent was carrying out, who is the one kept waiting. */
  asker?: AiChatAuthorInfo
  asks: ActionEntry[]
}

/** A chat whose changes wait to be kept or discarded, which is someone looking them over. */
export type Review = {
  chatId: number
  title: string
  /** The agent it is a run of, where it is one. */
  agent?: string
  /** The gadgets and worktrees it changes. */
  workpieces: number[]
  at: Date
}

/** A chat whose agent is at work now. */
export type Working = { chatId: number; title: string; agent?: string; at: Date }

export type AttentionInput = {
  chats: readonly AiChatMetadata[]
  /** The actions waiting, each once. */
  pending: readonly ActionEntry[]
  /** The chat each action was made in, by the action's id, where the action does not say. */
  actionChats: ReadonlyMap<number, number>
  /** The person who last asked something of each chat, by its id. */
  askers: ReadonlyMap<number, AiChatAuthorInfo>
}

const placeOf = (chat: AiChatMetadata | undefined, chatId: number | undefined): AttentionPlace => {
  if (chatId === undefined) return { kind: 'elsewhere' }
  if (!chat) return { kind: 'chat', chatId, title: 'A chat' }
  if (isAgentRun(chat)) return { kind: 'run', chatId, title: chatTitle(chat), agent: chat.spawnerName ?? 'An agent' }
  return { kind: 'chat', chatId, title: chatTitle(chat) }
}

/**
 * What waits on a decision in a workspace, a group for each place it was asked for: what stops a
 * chat's turn first, as someone is kept waiting on it, then what has waited longest. An action that
 * says no chat, as one a gadget asked for by itself does, is in one group of its own, last among
 * those waiting as long.
 */
export const attentionOf = ({ chats, pending, actionChats, askers }: AttentionInput): AttentionGroup[] => {
  const byId = new Map(chats.map((chat) => [chat.id, chat]))
  const groups = new Map<string, AttentionGroup>()
  for (const ask of pending.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)) {
    const chatId = ask.chatId ?? actionChats.get(ask.id)
    const key = chatId === undefined ? 'elsewhere' : `chat:${chatId}`
    const group = groups.get(key)
    if (group) {
      group.asks.push(ask)
      group.blocking ||= ask.description.awaitDecision === true
      continue
    }
    const chat = chatId === undefined ? undefined : byId.get(chatId)
    groups.set(key, {
      key,
      place: placeOf(chat, chatId),
      blocking: chat?.awaitingDecision === true || ask.description.awaitDecision === true,
      since: ask.createdAt,
      asker: chatId === undefined ? undefined : askers.get(chatId),
      asks: [ask],
    })
  }
  for (const chat of chats) {
    if (!chat.awaitingDecision || groups.has(`chat:${chat.id}`)) continue
    groups.set(`chat:${chat.id}`, { key: `chat:${chat.id}`, place: placeOf(chat, chat.id), blocking: true, since: chat.lastActive, asker: askers.get(chat.id), asks: [] })
  }
  return [...groups.values()].toSorted((a, b) => Number(b.blocking) - Number(a.blocking) || a.since.getTime() - b.since.getTime())
}

/** The chats with changes waiting to be kept, whose agent has finished, latest first. */
export const reviewsOf = (chats: readonly AiChatMetadata[]): Review[] =>
  chats
    .filter((chat) => (chat.proposedChangeWorkpieces?.length ?? 0) > 0 && !chat.activeAgent && !chat.awaitingDecision)
    .toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
    .map((chat) => ({
      chatId: chat.id,
      title: chatTitle(chat),
      ...(isAgentRun(chat) ? { agent: chat.spawnerName ?? 'An agent' } : {}),
      workpieces: chat.proposedChangeWorkpieces ?? [],
      at: chat.lastActive,
    }))

/** The chats whose agent is at work, latest first: people's before agents' runs, which come and go. */
export const workingOf = (chats: readonly AiChatMetadata[]): Working[] =>
  chats
    .filter((chat) => chat.activeAgent !== undefined)
    .toSorted((a, b) => Number(isAgentRun(a)) - Number(isAgentRun(b)) || b.lastActive.getTime() - a.lastActive.getTime())
    .map((chat) => ({ chatId: chat.id, title: chatTitle(chat), at: chat.lastActive, ...(isAgentRun(chat) ? { agent: chat.spawnerName ?? 'An agent' } : {}) }))

/** How many things wait on a decision: each action, and each chat stopped on one no action says. */
export const attentionCount = (groups: readonly AttentionGroup[]) => groups.reduce((sum, group) => sum + Math.max(1, group.asks.length), 0)
