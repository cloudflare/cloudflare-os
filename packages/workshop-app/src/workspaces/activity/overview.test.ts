import { describe, expect, it } from 'vitest'
import type { AiChatAuthorInfo, AiChatMetadata } from '@gadgets/workshop-shared/api'
import type { ActionEntry } from './activityEntries'
import { attentionCount, attentionOf, reviewsOf, workingOf } from './overview'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 12, minutes))
const chat = (id: number, minutes: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata =>
  ({ id, title: `Chat ${id}`, started: at(0), lastActive: at(minutes), ...more }) as AiChatMetadata
const ask = (id: number, chatId: number | undefined, minutes: number, awaitDecision = false): ActionEntry => ({
  id,
  type: 'action',
  from: 'agent',
  chatId,
  resourceTitle: 'Thing',
  createdAt: at(minutes),
  state: 'pending',
  description: { title: `Ask ${id}`, description: '', implementsRevert: false, autoApprovable: true, ...(awaitDecision ? { awaitDecision: true } : {}) },
})
const ada: AiChatAuthorInfo = { type: 'user', id: 'ada', name: 'Ada' }
const none = { actionChats: new Map<number, number>(), askers: new Map<number, AiChatAuthorInfo>() }

describe('attentionOf', () => {
  it('groups what waits by the chat it was asked in, oldest first within each, and says who is kept waiting', () => {
    const groups = attentionOf({ chats: [chat(1, 0), chat(2, 0)], pending: [ask(12, 1, 30), ask(11, 1, 10), ask(13, 2, 20)], ...none, askers: new Map([[1, ada]]) })
    expect(groups.map(({ key, asks, asker }) => [key, asks.map(({ id }) => id), asker?.name])).toEqual([
      ['chat:1', [11, 12], 'Ada'],
      ['chat:2', [13], undefined],
    ])
  })

  it('puts what stops a chat first, then what has waited longest', () => {
    const groups = attentionOf({ chats: [chat(1, 0), chat(2, 0), chat(3, 0, { awaitingDecision: true })], pending: [ask(1, 1, 5), ask(2, 2, 40, true), ask(3, 3, 50)], ...none })
    expect(groups.map(({ key, blocking }) => [key, blocking])).toEqual([['chat:2', true], ['chat:3', true], ['chat:1', false]])
  })

  it('finds an action’s chat from its messages where the action does not say, and gathers those in no chat', () => {
    const groups = attentionOf({ chats: [chat(4, 0)], pending: [ask(1, undefined, 1), ask(2, undefined, 2)], actionChats: new Map([[2, 4]]), askers: new Map() })
    expect(groups.map(({ key, place, asks }) => [key, place.kind, asks.map(({ id }) => id)])).toEqual([['elsewhere', 'elsewhere', [1]], ['chat:4', 'chat', [2]]])
  })

  it('names an agent’s run by its agent', () => {
    const [group] = attentionOf({ chats: [chat(5, 0, { spawnerId: 9, spawnerName: 'Inbox helper', title: 'Reply' })], pending: [ask(1, 5, 0)], ...none })
    expect(group.place).toEqual({ kind: 'run', chatId: 5, title: 'Reply', agent: 'Inbox helper' })
  })

  it('lists a chat stopped on a decision no action says, as one thing waiting', () => {
    const groups = attentionOf({ chats: [chat(6, 15, { awaitingDecision: true })], pending: [], ...none })
    expect(groups).toMatchObject([{ key: 'chat:6', blocking: true, asks: [], since: at(15) }])
    expect(attentionCount(groups)).toBe(1)
  })
})

describe('reviewsOf', () => {
  it('lists the chats with changes to keep whose agent has finished, latest first', () => {
    const chats = [
      chat(1, 10, { proposedChangeWorkpieces: [3] }),
      chat(2, 20, { proposedChangeWorkpieces: [4, 5], spawnerName: 'Digest' }),
      chat(3, 30, { proposedChangeWorkpieces: [6], activeAgent: { type: 'agent', id: 'm', name: 'M' } }),
      chat(4, 40, { proposedChangeWorkpieces: [] }),
    ]
    expect(reviewsOf(chats).map(({ chatId, agent, workpieces }) => [chatId, agent, workpieces])).toEqual([[2, 'Digest', [4, 5]], [1, undefined, [3]]])
  })
})

describe('workingOf', () => {
  it('lists people’s chats at work before agents’ runs', () => {
    const working = { activeAgent: { type: 'agent' as const, id: 'm', name: 'M' } }
    expect(workingOf([chat(1, 50, { ...working, spawnerName: 'Bot' }), chat(2, 10, working), chat(3, 60)]).map(({ chatId }) => chatId)).toEqual([2, 1])
  })
})

