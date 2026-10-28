import { describe, expect, it, vi } from 'vitest'
import type { AiChatHistoryPage, AiChatMessage, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { ChatSession, type ChatOverseer } from './ChatSession'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const chat = (id: number, title: string, lastActive: number): AiChatMetadata => ({
  id,
  title,
  started: new Date(0),
  lastActive: new Date(lastActive),
})

const userMessage = (sequence: number, text: string): AiChatMessage => ({
  chatId: 0,
  sequence,
  timestamp: new Date(0),
  author: { type: 'user', id: 'u', name: 'User' },
  type: 'message',
  message: text,
})

const page = (...messages: AiChatMessage[]): AiChatHistoryPage => ({ messages })

const fakeOverseer = (chats: Promise<AiChatMetadata[]>, histories: Record<number, AiChatHistoryPage> = {}) => {
  const getChatHistory = vi.fn<(chatId: number) => Promise<AiChatHistoryPage>>(
    async (chatId) => histories[chatId] ?? page(),
  )
  const dispose = vi.fn<() => void>()
  const overseer: ChatOverseer = { listChats: () => chats, getChatHistory, [Symbol.dispose]: dispose }
  return { overseer, getChatHistory, dispose }
}

const settled = (session: ChatSession) =>
  vi.waitFor(() => expect(session.getSnapshot().status).not.toBe('loading'))

describe('ChatSession', () => {
  it('shows the most recently active chat: its title and messages', async () => {
    const { overseer, getChatHistory } = fakeOverseer(
      Promise.resolve([chat(0, 'Old chat', 100), chat(1, 'Newest chat', 300), chat(2, 'Middle chat', 200)]),
      { 1: page(userMessage(0, 'hello')) },
    )
    const session = new ChatSession(() => overseer)
    session.start()
    await settled(session)

    expect(getChatHistory).toHaveBeenCalledExactlyOnceWith(1)
    expect(session.getSnapshot()).toMatchObject({
      status: 'ready',
      title: 'Newest chat',
      items: [{ kind: 'user', text: 'hello' }],
    })
  })

  it('is ready and empty for a workspace with no chats yet', async () => {
    const { overseer, getChatHistory } = fakeOverseer(Promise.resolve([]))
    const session = new ChatSession(() => overseer)
    session.start()
    await settled(session)

    expect(getChatHistory).not.toHaveBeenCalled()
    expect(session.getSnapshot()).toEqual({ status: 'ready', title: undefined, items: [] })
  })

  it('reports why loading failed', async () => {
    const { overseer } = fakeOverseer(Promise.reject(new Error("You don't have access to this workspace.")))
    const session = new ChatSession(() => overseer)
    session.start()
    await settled(session)

    expect(session.getSnapshot()).toEqual({
      status: 'failed',
      message: "You don't have access to this workspace.",
    })
  })

  it('notifies subscribers when the snapshot changes, and not after they unsubscribe', async () => {
    const { overseer } = fakeOverseer(Promise.resolve([]))
    const session = new ChatSession(() => overseer)
    const listener = vi.fn<() => void>()
    const unsubscribe = session.subscribe(listener)
    session.start()
    await settled(session)
    expect(listener).toHaveBeenCalled()

    unsubscribe()
    listener.mockClear()
    session.start()
    await settled(session)
    expect(listener).not.toHaveBeenCalled()
  })

  describe('stop', () => {
    it('releases the workspace and drops a load that finishes afterwards', async () => {
      const chats = deferred<AiChatMetadata[]>()
      const { overseer, dispose } = fakeOverseer(chats.promise, { 0: page(userMessage(0, 'late')) })
      const session = new ChatSession(() => overseer)
      session.start()
      session.stop()
      expect(dispose).toHaveBeenCalledOnce()

      chats.resolve([chat(0, 'Late chat', 1)])
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(session.getSnapshot()).toEqual({ status: 'loading' })
    })

    it('does not dispose twice, and is harmless before start', () => {
      const { overseer, dispose } = fakeOverseer(Promise.resolve([]))
      const session = new ChatSession(() => overseer)
      session.stop()
      expect(dispose).not.toHaveBeenCalled()

      session.start()
      session.stop()
      session.stop()
      expect(dispose).toHaveBeenCalledOnce()
    })

    it('opens nothing for a session that was never started', () => {
      const open = vi.fn<() => ChatOverseer>()
      const session = new ChatSession(open)
      expect(open).not.toHaveBeenCalled()
      expect(session.getSnapshot()).toEqual({ status: 'loading' })
    })
  })

  describe('restart (React runs an effect, its cleanup, then the effect again in development)', () => {
    it('ignores the first run when it finishes after the second has started', async () => {
      const first = deferred<AiChatMetadata[]>()
      const second = deferred<AiChatMetadata[]>()
      const one = fakeOverseer(first.promise, { 0: page(userMessage(0, 'from the first run')) })
      const two = fakeOverseer(second.promise, { 5: page(userMessage(0, 'from the second run')) })
      const overseers = [one.overseer, two.overseer]
      const session = new ChatSession(() => overseers.shift()!)

      session.start()
      session.stop()
      session.start()
      second.resolve([chat(5, 'Second', 1)])
      await settled(session)
      first.resolve([chat(0, 'First', 2)])
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(one.dispose).toHaveBeenCalledOnce()
      expect(two.dispose).not.toHaveBeenCalled()
      expect(session.getSnapshot()).toMatchObject({ status: 'ready', title: 'Second' })
    })
  })
})
