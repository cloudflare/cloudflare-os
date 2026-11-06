import { describe, expect, it, vi } from 'vitest'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { startConversation, type NewConversationOverseer } from './startConversation'

const fakeOverseer = (workspaceId = 'ws-1') => {
  const newChat = vi.fn<Overseer['newChat']>(async () => 0)
  const getMetadata = vi.fn<Overseer['getMetadata']>(async () => ({ id: workspaceId, title: 'Untitled Workspace' }))
  const dispose = vi.fn<() => void>()
  const overseer: NewConversationOverseer = { newChat, getMetadata, [Symbol.dispose]: dispose }
  return { overseer, newChat, getMetadata, dispose }
}

describe('startConversation', () => {
  it('starts the chat with the message and model, and returns the workspace id', async () => {
    const fake = fakeOverseer('abc123')

    const id = await startConversation(() => fake.overseer, 'Build me a dashboard', 'model-1')

    expect(id).toBe('abc123')
    expect(fake.newChat).toHaveBeenCalledExactlyOnceWith('Build me a dashboard', 'model-1')
  })

  it('releases the workspace connection when it succeeds', async () => {
    const fake = fakeOverseer()
    await startConversation(() => fake.overseer, 'hi', 'model-1')
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it('releases it, and passes the failure on, when the chat cannot be started', async () => {
    const fake = fakeOverseer()
    fake.newChat.mockRejectedValueOnce(new Error('No such model'))

    await expect(startConversation(() => fake.overseer, 'hi', 'bad-model')).rejects.toThrow('No such model')
    expect(fake.dispose).toHaveBeenCalledOnce()
  })
})
