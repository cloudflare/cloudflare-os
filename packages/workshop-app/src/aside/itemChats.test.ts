import { describe, expect, it } from 'vitest'
import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import { itemChats } from './itemChats'

const day = (n: number) => new Date(2026, 10, n, 10)
const chat = (id: number, title: string, lastActive: Date, rest: Partial<AiChatMetadata> = {}): AiChatMetadata => ({
  id, title, started: lastActive, lastActive, ...rest,
})
const nothingShown = () => undefined

describe('itemChats', () => {
  it('lists the workspace’s chats, most recent first', () => {
    const chats = itemChats([chat(1, 'Older', day(3)), chat(2, '', day(5))], 'w', '12', nothingShown)
    expect(chats.map(({ chatId, title }) => [chatId, title])).toEqual([[2, 'Untitled chat'], [1, 'Older']])
  })

  it('puts the chats that last had the item open first, and offers no more than four', () => {
    const chats = itemChats([1, 2, 3, 4, 5, 6].map((id) => chat(id, `Chat ${id}`, day(id))), 'w', '12', (workspaceId, chatId) =>
      workspaceId !== 'w' ? undefined : chatId === 2 ? '12' : chatId === 5 ? '13' : undefined)
    expect(chats.map(({ chatId, showing }) => [chatId, showing])).toEqual([[2, true], [6, false], [5, false], [4, false]])
  })
})
