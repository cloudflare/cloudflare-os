import { describe, expect, it } from 'vitest'
import type { AiChatAuthorInfo, AiChatMessage, AiChatMetadata, ChatReadState } from '@gadgets/workshop-shared/api'
import { RECENT_FOR, recentChatsOf, tailOf, tailsWanted, type ChatTail, type WorkspaceChatsReading } from './recentChats'

const NOW = 10 * RECENT_FOR
const ago = (minutes: number) => new Date(NOW - minutes * 60_000)
const chat = (id: number, minutesAgo: number, more: Partial<AiChatMetadata> = {}) =>
  ({ id, title: `Chat ${id}`, started: ago(minutesAgo + 10), lastActive: ago(minutesAgo), ...more }) as AiChatMetadata
const read = (chatId: number, more: Partial<ChatReadState> = {}): ChatReadState => ({ workspaceId: 'w', chatId, unreadMessageCount: 0, readThroughSequence: 3, ...more })
const reading = (chats: AiChatMetadata[], readStates: ChatReadState[] = [], approvals: number[] = []): WorkspaceChatsReading => ({ chats, readStates, approvals: new Set(approvals) })
const listed = (readings: Record<string, WorkspaceChatsReading>, tails: Record<string, ChatTail> = {}, hidden: Record<string, number> = {}) =>
  recentChatsOf(new Map(Object.entries(readings)), new Map(Object.entries(tails)), new Map(Object.entries(hidden)), NOW).map(({ key }) => key)

const ada: AiChatAuthorInfo = { type: 'user', id: 'ada', name: 'Ada' }
const grace: AiChatAuthorInfo = { type: 'user', id: 'grace', name: 'Grace' }
const message = (author: AiChatAuthorInfo, text: string) => ({ type: 'message', author, message: text, timestamp: ago(1) }) as AiChatMessage

describe('recentChatsOf', () => {
  it('lists the chats the viewer has read, asked to hear of, or wrote in, the latest first', () => {
    const chats = [chat(1, 30), chat(2, 5), chat(3, 10), chat(4, 1), chat(5, 2, { notificationsRequireParticipation: true })]
    const states = [read(1), read(2, { readThroughSequence: -1, notificationsEnabledOverride: true }), read(5, { readThroughSequence: -1, notificationsEnabled: true })]
    const tails = { 'w:3': { lastActive: ago(10).getTime(), wrote: true } }
    // Chat 4 the viewer has never opened, written in or asked to hear of.
    expect(listed({ w: reading(chats, states) }, tails)).toEqual(['w:5', 'w:2', 'w:3', 'w:1'])
  })

  it('puts what waits on a person first, an agent’s run only while it does', () => {
    const chats = [chat(1, 1), chat(2, 50, { awaitingDecision: true }), chat(3, 20, { spawnerName: 'Inbox' }), chat(4, 30, { spawnerName: 'Inbox' })]
    expect(listed({ w: reading(chats, [read(1), read(3)], [4]) })).toEqual(['w:4', 'w:2', 'w:1'])
  })

  it('leaves out what was last active too long ago, unless it waits', () => {
    const old = RECENT_FOR / 60_000 + 1
    expect(listed({ w: reading([chat(1, old), chat(2, old, { awaitingDecision: true })], [read(1)]) })).toEqual(['w:2'])
  })

  it('leaves out a chat taken out of the sidebar until it waits on a person after more happened in it', () => {
    const states = [read(1), read(2)]
    const hidden = { 'w:1': ago(5).getTime(), 'w:2': ago(5).getTime() }
    expect(listed({ w: reading([chat(1, 5), chat(2, 5)], states) }, {}, hidden)).toEqual([])
    expect(listed({ w: reading([chat(1, 1), chat(2, 1, { awaitingDecision: true })], states) }, {}, hidden)).toEqual(['w:2'])
  })

  it('says it is unread only where the viewer hears of it, and muted where they muted it', () => {
    const states = [read(1, { unreadMessageCount: 2 }), read(2, { unreadMessageCount: 2, notificationsEnabled: false, notificationsEnabledOverride: false })]
    const [first, second] = recentChatsOf(new Map([['w', reading([chat(1, 1), chat(2, 2)], states)]]), new Map(), new Map(), NOW)
    expect(first).toMatchObject({ key: 'w:1', unread: true, muted: false })
    expect(second).toMatchObject({ key: 'w:2', unread: false, muted: true })
  })

  it('says what a chat last said only for the chat as it was when read, and what it asks while it waits', () => {
    const latest = { text: 'Done', author: grace, at: ago(5) }
    const ask = { text: 'Connect Jira', author: grace, at: ago(5) }
    const tails = { 'w:1': { lastActive: ago(5).getTime(), latest, wrote: false }, 'w:2': { lastActive: ago(9).getTime(), latest, wrote: false }, 'w:3': { lastActive: ago(5).getTime(), latest, ask, wrote: false } }
    const chats = recentChatsOf(new Map([['w', reading([chat(1, 5), chat(2, 5), chat(3, 5, { awaitingDecision: true })], [read(1), read(2)])]]), new Map(Object.entries(tails)), new Map(), NOW)
    expect(Object.fromEntries(chats.map(({ key, latest: said }) => [key, said?.text]))).toEqual({ 'w:3': 'Connect Jira', 'w:1': 'Done', 'w:2': undefined })
  })
})

describe('tailsWanted', () => {
  it('reads the latest few chats people had, and whatever waits, but no other runs', () => {
    const chats = [...Array.from({ length: 8 }, (_, index) => chat(index + 1, index)), chat(20, 0, { spawnerName: 'Inbox' }), chat(21, 900, { awaitingDecision: true })]
    expect(tailsWanted(reading(chats), NOW).map(({ id }) => id)).toEqual([1, 2, 3, 4, 5, 6, 21])
  })
})

describe('tailOf', () => {
  it('says whether the viewer wrote, and what was last said', () => {
    const tail = tailOf([message(ada, 'Can you check Tuesday?'), message(grace, '**Tuesday** works')], ago(1), 'ada')
    expect(tail).toMatchObject({ wrote: true, latest: { text: 'Tuesday works', author: grace } })
    expect(tailOf([message(grace, 'Hello')], ago(1), 'ada').wrote).toBe(false)
  })
})
