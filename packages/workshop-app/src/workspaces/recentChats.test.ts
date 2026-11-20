import { describe, expect, it } from 'vitest'
import type { UnreadThread, WorkspaceSummary, WorkspaceWaitingChat } from '@gadgets/workshop-shared/api'
import { RECENT_FOR, recentChatsOf } from './recentChats'

const NOW = 10 * RECENT_FOR
const ago = (minutes: number) => new Date(NOW - minutes * 60_000)
const grace = { type: 'user' as const, id: 'grace', name: 'Grace' }

const thread = (chatId: number, minutesAgo: number, more: Partial<UnreadThread> = {}): UnreadThread => ({
  workspaceId: 'w', chatId, unreadMessageCount: 0, readThroughSequence: 3, notificationsEnabled: true,
  chatTitle: `Chat ${chatId}`, latestSequence: 3, latestMessagePreview: `Said in ${chatId}`, latestActivityAt: ago(minutesAgo), ...more,
})
const waits = (chatId: number, minutesAgo: number, more: Partial<WorkspaceWaitingChat> = {}): WorkspaceWaitingChat =>
  ({ chatId, title: `Chat ${chatId}`, lastActive: ago(minutesAgo), waiting: 'action', ...more })
const summaries = (waitingChats: WorkspaceWaitingChat[] = [], workingChatIds: number[] = []) =>
  new Map<string, WorkspaceSummary>([['w', { workspaceId: 'w', waiting: { runs: 0, chats: 0, gadgets: [] }, waitingChats, workingChatIds, hooks: [] }]])
const listed = (threads: UnreadThread[], summary = summaries(), hidden: Record<string, number> = {}) =>
  recentChatsOf(threads, summary, new Map(Object.entries(hidden)), NOW)

describe('recentChatsOf', () => {
  it('lists the chats the viewer has read, asked to hear of, or wrote in, the latest first', () => {
    const threads = [
      thread(1, 30),
      thread(2, 5, { readThroughSequence: -1, notificationsEnabledOverride: true }),
      thread(3, 10, { readThroughSequence: -1, participated: true }),
      // Never opened, written in or asked to hear of.
      thread(4, 1, { readThroughSequence: -1 }),
    ]
    expect(listed(threads).map(({ key }) => key)).toEqual(['w:2', 'w:3', 'w:1'])
  })

  it('lists what waits on a person among the rest, by when it was last active, whether or not the viewer takes part', () => {
    expect(listed([thread(1, 1), thread(2, 40)], summaries([waits(3, 20, { spawnerName: 'Inbox' }), waits(2, 10)])).map(({ key, waiting }) => [key, waiting]))
      .toEqual([['w:1', undefined], ['w:2', 'action'], ['w:3', 'action']])
  })

  it('leaves out what was last active too long ago, unless it waits', () => {
    const old = RECENT_FOR / 60_000 + 1
    expect(listed([thread(1, old), thread(2, old)], summaries([waits(2, old)])).map(({ key }) => key)).toEqual(['w:2'])
  })

  it('leaves out a chat taken out of the sidebar until it waits on a person after more happened in it', () => {
    const hidden = { 'w:1': ago(5).getTime(), 'w:2': ago(5).getTime() }
    expect(listed([thread(1, 5), thread(2, 5)], summaries(), hidden)).toEqual([])
    expect(listed([thread(1, 1), thread(2, 1)], summaries([waits(2, 1)]), hidden).map(({ key }) => key)).toEqual(['w:2'])
  })

  it('says it is unread only where the viewer hears of it, muted where they muted it, and working while its agent works', () => {
    const [first, second] = listed([
      thread(1, 1, { unreadMessageCount: 2 }),
      thread(2, 2, { unreadMessageCount: 2, notificationsEnabled: false, notificationsEnabledOverride: false }),
    ], summaries([], [2]))
    expect(first).toMatchObject({ key: 'w:1', unread: true, muted: false, working: false })
    expect(second).toMatchObject({ key: 'w:2', unread: false, muted: true, working: true })
  })

  it('says what a chat last said and who said it, and what it asks while it waits', () => {
    const chats = listed(
      [thread(1, 5, { latestAuthor: grace, latestMessagePreview: '**Done**' }), thread(2, 6, { latestMessagePreview: '' }), thread(3, 4)],
      summaries([waits(3, 4, { ask: { type: 'connection', vendorName: 'Jira', reason: 'To read issues' } })]),
    )
    expect(Object.fromEntries(chats.map(({ key, latest }) => [key, latest]))).toEqual({
      'w:3': { text: 'Connect Jira · To read issues' },
      'w:1': { text: 'Done', author: grace },
      'w:2': undefined,
    })
  })
})
