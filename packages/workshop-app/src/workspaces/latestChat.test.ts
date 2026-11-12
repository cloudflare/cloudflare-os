import { describe, expect, it, vi } from 'vitest'
import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import { latestChat } from './latestChat'

const chat = (id: number, lastActive: number): AiChatMetadata => ({ id, title: `Chat ${id}`, started: new Date(0), lastActive: new Date(lastActive) })

describe('latestChat', () => {
  it('finds the chat active last, and lets go of the workspace', async () => {
    const dispose = vi.fn<() => void>()
    const found = await latestChat(() => ({ listChats: async () => [chat(1, 10), chat(2, 30), chat(3, 20)], [Symbol.dispose]: dispose }))
    expect(found?.id).toBe(2)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('finds nothing in a workspace with no chats, and lets go of it when listing fails', async () => {
    expect(await latestChat(() => ({ listChats: async () => [], [Symbol.dispose]: () => {} }))).toBeUndefined()
    const dispose = vi.fn<() => void>()
    await expect(latestChat(() => ({ listChats: () => Promise.reject(new Error('gone')), [Symbol.dispose]: dispose }))).rejects.toThrow('gone')
    expect(dispose).toHaveBeenCalledOnce()
  })
})
