import { isAgentRun, type AiChatAuthorInfo, type AiChatMetadata } from '@gadgets/workshop-shared/api'
import type { AttentionGroup, Review, Working } from './activity/overview'

/** An agent whose latest run failed, which nothing has run since to put right. */
export type FailedRun = { chatId: number; title: string; agent: string; at: Date }

/** What a chat in progress is at: waiting on an approval or an answer, failed, ready for review, or working. */
export type ChatStateKind = 'approval' | 'answer' | 'failed' | 'review' | 'working'

/** Where a chat in progress stands: what it is at, in a word or two, and its place among the rest in progress. */
export type ChatState = {
  kind: ChatStateKind
  /** "Needs approval", "Run failed". */
  words: string
  /** In order: approvals (paused ones first, then the longest waiting), answers, failures, reviews, then work, of which a chat takes the first. */
  rank: number
}

const KIND_ORDER: ChatStateKind[] = ['approval', 'answer', 'failed', 'review', 'working']

/** Who a chat is by, as its row shows: the person who started it (the viewer as "You"), or the agent a run is of. */
export type ChatBy = { kind: 'person'; name: string; fullName: string } | { kind: 'agent'; name: string }

export const chatByOf = (chat: AiChatMetadata, person: AiChatAuthorInfo | undefined, viewerId: string | undefined): ChatBy | undefined => {
  if (isAgentRun(chat)) return { kind: 'agent', name: chat.spawnerName ?? 'An agent' }
  if (person?.type !== 'user') return undefined
  return { kind: 'person', name: person.id === viewerId ? 'You' : person.name, fullName: person.name }
}

/**
 * How each chat in progress stands, by its id: waiting on an approval or an answer (where nothing
 * says what, as for a connection), its latest run failed, its changes waiting to be kept, or its
 * agent at work. A chat stands one way only, the first of those it is in.
 */
export const chatStatesOf = (
  { attention, failed, reviews, working }: {
    attention: readonly AttentionGroup[]
    failed: readonly FailedRun[]
    reviews: readonly Review[]
    working: readonly Working[]
  },
): Map<number, ChatState> => {
  const found: Array<{ chatId: number } & Omit<ChatState, 'rank'>> = []
  for (const group of attention) {
    if (group.place.kind === 'elsewhere') continue
    // However many approvals it waits on, it needs approval: the chat says what each is.
    if (group.asks.length === 0) found.push({ chatId: group.place.chatId, kind: 'answer', words: 'Needs action' })
    else found.push({ chatId: group.place.chatId, kind: 'approval', words: 'Needs approval' })
  }
  for (const run of failed) found.push({ chatId: run.chatId, kind: 'failed', words: 'Run failed' })
  for (const review of reviews) found.push({ chatId: review.chatId, kind: 'review', words: 'Ready for review' })
  for (const chat of working) found.push({ chatId: chat.chatId, kind: 'working', words: 'Working…' })
  // Stable, so that each kind keeps the order it was found in: attention's, paused and longest waiting first.
  const ordered = found
    .map((each, index) => ({ each, index }))
    .toSorted((a, b) => KIND_ORDER.indexOf(a.each.kind) - KIND_ORDER.indexOf(b.each.kind) || a.index - b.index)
  const states = new Map<number, ChatState>()
  for (const { each: { chatId, ...state } } of ordered) {
    if (!states.has(chatId)) states.set(chatId, { ...state, rank: states.size })
  }
  return states
}

/**
 * Who said a chat's latest message, as its row puts it before the message: the agent a run is
 * of; in a chat people had, "You" or the person, but not the assistant, whose chat it is.
 */
export const speakerOf = (chat: AiChatMetadata, author: AiChatAuthorInfo | undefined, viewerId: string | undefined): string | undefined => {
  if (isAgentRun(chat)) return author?.type === 'user' ? (author.id === viewerId ? 'You' : author.name) : chat.spawnerName ?? 'An agent'
  if (author?.type !== 'user') return undefined
  return author.id === viewerId ? 'You' : author.name
}


