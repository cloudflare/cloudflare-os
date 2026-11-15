import { describe, expect, it } from 'vitest'
import type { UnreadThread } from '@gadgets/workshop-shared/api'
import { itemChats } from './itemChats'

const day = (n: number) => new Date(2026, 10, n, 10)
const thread = (workspaceId: string, chatId: number, chatTitle: string, at: Date, rest: Partial<UnreadThread> = {}): UnreadThread => ({
  workspaceId, chatId, chatTitle, latestActivityAt: at, latestSequence: 1, unreadMessageCount: 0, readThroughSequence: 1, ...rest,
})
const nothingShown = () => undefined

describe('itemChats', () => {
  it('lists the workspace’s chats, most recent first, leaving out archived, unjoined and agent-started ones and other workspaces’', () => {
    const chats = itemChats([
      thread('w', 1, 'Older', day(3)),
      thread('w', 2, '', day(5)),
      thread('w', 3, 'Archived', day(9), { archived: true }),
      thread('w', 4, 'Theirs', day(9), { unjoined: true }),
      thread('w', 5, 'Joke', day(9), { spawnerName: 'Joke' }),
      thread('x', 6, 'Elsewhere', day(9)),
    ], 'w', '12', nothingShown)
    expect(chats.map(({ chatId, title }) => [chatId, title])).toEqual([[2, 'Untitled chat'], [1, 'Older']])
  })

  it('puts the chats that last had the item open first, and offers no more than four', () => {
    const threads = [1, 2, 3, 4, 5, 6].map((chatId) => thread('w', chatId, `Chat ${chatId}`, day(chatId)))
    const chats = itemChats(threads, 'w', '12', (_, chatId) => (chatId === 2 ? '12' : chatId === 5 ? '13' : undefined))
    expect(chats.map(({ chatId, showing }) => [chatId, showing])).toEqual([[2, true], [6, false], [5, false], [4, false]])
  })
})
