import { describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AiChatHistoryPage,
  AiChatMessage,
  AiChatMetadata,
  Overseer,
} from '@gadgets/workshop-shared/api'
import { ChatSession, type ChatOverseer, type ChatSnapshot } from './ChatSession'
import { ChatSubscriber } from './ChatSubscriber'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const userAuthor: AiChatAuthorInfo = { type: 'user', id: 'u', name: 'User' }
const agentAuthor: AiChatAuthorInfo = { type: 'agent', id: 'a', name: 'Agent' }

const chat = (id: number, title: string, lastActive: number, activeAgent?: AiChatAuthorInfo): AiChatMetadata => ({
  id,
  title,
  started: new Date(0),
  lastActive: new Date(lastActive),
  activeAgent,
})

const message = (sequence: number, text: string, author = userAuthor, chatId = 0): AiChatMessage => ({
  chatId,
  sequence,
  timestamp: new Date(0),
  author,
  type: 'message',
  message: text,
})
const userMessage = (sequence: number, text: string, chatId = 0) => message(sequence, text, userAuthor, chatId)
const agentMessage = (sequence: number, text: string, chatId = 0) => message(sequence, text, agentAuthor, chatId)

const page = (...messages: AiChatMessage[]): AiChatHistoryPage => ({ messages })

/** A workspace's Overseer, plus what a test needs to act as the server: the subscriber it was given. */
const fakeOverseer = (chats: Promise<AiChatMetadata[]>, histories: Record<number, AiChatHistoryPage> = {}) => {
  let subscriber: ChatSubscriber | undefined
  const dispose = vi.fn<() => void>()
  const leaseDispose = vi.fn<() => void>()
  // Only its disposer matters to the session.
  const lease = { [Symbol.dispose]: leaseDispose } as unknown as RpcStub<{}>

  const listChats = vi.fn<() => Promise<AiChatMetadata[]>>(() => chats)
  const getChatHistory = vi.fn<Overseer['getChatHistory']>(
    async (chatId) => histories[chatId] ?? page(),
  )
  const subscribeToChat = vi.fn<ChatOverseer['subscribeToChat']>((given) => {
    // The server must receive one RpcTarget object, not a bag of callbacks.
    if (!(given instanceof ChatSubscriber)) throw new Error('subscribeToChat was not given a ChatSubscriber')
    subscriber = given
    return Promise.resolve(lease)
  })
  const sendChatMessage = vi.fn<Overseer['sendChatMessage']>(async () => {})
  const newChat = vi.fn<Overseer['newChat']>(async () => 0)

  const overseer: ChatOverseer = {
    listChats,
    getChatHistory,
    subscribeToChat,
    sendChatMessage,
    newChat,
    [Symbol.dispose]: dispose,
  }
  return {
    overseer,
    listChats,
    getChatHistory,
    subscribeToChat,
    sendChatMessage,
    newChat,
    dispose,
    leaseDispose,
    /** What the server calls with chat activity. */
    server: () => subscriber!,
  }
}

const settled = (session: ChatSession) =>
  vi.waitFor(() => expect(session.getSnapshot().status).not.toBe('loading'))

const ready = (session: ChatSession) => {
  const snapshot: ChatSnapshot = session.getSnapshot()
  if (snapshot.status !== 'ready') throw new Error(`expected a ready session, got ${snapshot.status}`)
  return snapshot
}

const started = async (fake: ReturnType<typeof fakeOverseer>, options?: ConstructorParameters<typeof ChatSession>[1]) => {
  const session = new ChatSession(() => fake.overseer, options)
  session.start()
  await settled(session)
  return session
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('ChatSession', () => {
  describe('loading', () => {
    it('shows the most recently active chat: its title and messages', async () => {
      const fake = fakeOverseer(
        Promise.resolve([chat(0, 'Old chat', 100), chat(1, 'Newest chat', 300), chat(2, 'Middle chat', 200)]),
        { 1: page(userMessage(0, 'hello', 1)) },
      )
      const session = await started(fake)

      expect(fake.getChatHistory).toHaveBeenCalledExactlyOnceWith(1, undefined, 50)
      expect(ready(session)).toMatchObject({ title: 'Newest chat', items: [{ kind: 'user', text: 'hello' }] })
    })

    it('is ready and empty for a workspace with no chats yet', async () => {
      const fake = fakeOverseer(Promise.resolve([]))
      const session = await started(fake)

      expect(fake.getChatHistory).not.toHaveBeenCalled()
      expect(ready(session)).toMatchObject({ title: undefined, items: [], thinking: false, streamingText: '' })
    })

    it('reports why loading failed', async () => {
      const fake = fakeOverseer(Promise.reject(new Error("You don't have access to this workspace.")))
      const session = await started(fake)

      expect(session.getSnapshot()).toEqual({ status: 'failed', message: "You don't have access to this workspace." })
    })

    it('reports a subscription that cannot be made', async () => {
      const fake = fakeOverseer(Promise.resolve([]))
      fake.subscribeToChat.mockReturnValueOnce(Promise.reject(new Error('subscription refused')))
      const session = await started(fake)

      expect(session.getSnapshot()).toEqual({ status: 'failed', message: 'subscription refused' })
    })

    it('subscribes before it reads anything, so nothing in between is missed', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      await started(fake)

      expect(fake.subscribeToChat.mock.invocationCallOrder[0]).toBeLessThan(fake.listChats.mock.invocationCallOrder[0])
      expect(fake.subscribeToChat.mock.invocationCallOrder[0]).toBeLessThan(
        fake.getChatHistory.mock.invocationCallOrder[0],
      )
    })

    it('starts thinking when an agent turn was already running', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1, agentAuthor)]))
      const session = await started(fake)

      expect(ready(session).thinking).toBe(true)
    })

    it('notifies subscribers when the snapshot changes, and not after they unsubscribe', async () => {
      const fake = fakeOverseer(Promise.resolve([]))
      const session = new ChatSession(() => fake.overseer)
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
  })

  describe('older history', () => {
    it('uses bounded pages and the server cursor, preserving live updates during a fetch', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]), {
        0: { messages: [userMessage(50, 'recent')], nextBeforeSequence: 50 },
      })
      const session = await started(fake)
      const older = deferred<AiChatHistoryPage>()
      fake.getChatHistory.mockReturnValueOnce(older.promise)
      const loading = session.loadEarlier()
      await session.loadEarlier()
      expect(fake.getChatHistory).toHaveBeenCalledTimes(2)
      expect(fake.getChatHistory).toHaveBeenLastCalledWith(0, 50, 50)
      expect(ready(session).loadingEarlier).toBe(true)

      fake.server().message(userMessage(12, 'updated while reading'))
      fake.server().message(userMessage(51, 'new live message'))
      expect(ready(session).items.map(({ id }) => id)).toEqual([50, 51])
      older.resolve(page(userMessage(0, 'oldest'), userMessage(12, 'stale snapshot')))
      await loading
      expect(ready(session)).toMatchObject({ hasEarlier: false, loadingEarlier: false, items: [
        { id: 0, text: 'oldest' },
        { id: 12, text: 'updated while reading' },
        { id: 50, text: 'recent' },
        { id: 51, text: 'new live message' },
      ] })
      await session.loadEarlier()
      expect(fake.getChatHistory).toHaveBeenCalledTimes(2)
    })

    it('retains the cursor through a failed read and allows retry without losing streaming text', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]), {
        0: { messages: [userMessage(10, 'recent')], nextBeforeSequence: 10 },
      })
      const session = await started(fake)
      fake.server().stream(0, { type: 'textDelta', delta: 'reply in progress' })
      fake.getChatHistory.mockRejectedValueOnce(new Error('temporarily unavailable'))
      await session.loadEarlier()
      expect(ready(session)).toMatchObject({ hasEarlier: true, loadingEarlier: false, historyError: 'temporarily unavailable' })
      fake.getChatHistory.mockResolvedValueOnce(page(userMessage(0, 'oldest')))
      await session.loadEarlier()
      expect(fake.getChatHistory).toHaveBeenLastCalledWith(0, 10, 50)
      expect(ready(session)).toMatchObject({ hasEarlier: false, historyError: undefined, streamingText: 'reply in progress' })
    })

    it('pages through history that contains no renderable items', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]), {
        0: { messages: [agentMessage(20, '')], nextBeforeSequence: 20 },
      })
      const session = await started(fake)
      expect(ready(session)).toMatchObject({ items: [], hasEarlier: true })
      fake.getChatHistory.mockResolvedValueOnce({ messages: [agentMessage(10, '')], nextBeforeSequence: 10 })
      await session.loadEarlier()
      fake.getChatHistory.mockResolvedValueOnce(page(userMessage(0, 'visible')))
      await session.loadEarlier()
      expect(fake.getChatHistory).toHaveBeenLastCalledWith(0, 10, 50)
      expect(ready(session)).toMatchObject({ hasEarlier: false, items: [{ text: 'visible' }] })
    })

    it('discards an older page that completes after the session restarts', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]), {
        0: { messages: [userMessage(50, 'recent')], nextBeforeSequence: 50 },
      })
      const session = await started(fake)
      const older = deferred<AiChatHistoryPage>()
      fake.getChatHistory.mockReturnValueOnce(older.promise)
      const loading = session.loadEarlier()
      session.stop()
      session.start()
      await settled(session)
      older.resolve(page(userMessage(0, 'stale page')))
      await loading
      expect(ready(session)).toMatchObject({ hasEarlier: true, loadingEarlier: false, items: [{ id: 50 }] })
    })
  })

  describe('live activity', () => {
    it('appends new messages after the history, and stores a replayed sequence once', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]), { 0: page(userMessage(0, 'first')) })
      const session = await started(fake)

      fake.server().message(userMessage(0, 'first'))
      fake.server().message(agentMessage(1, 'second'))

      expect(ready(session).items).toMatchObject([
        { kind: 'user', text: 'first' },
        { kind: 'assistant', text: 'second' },
      ])
    })

    it('puts messages in sequence order even when they arrive out of order', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const session = await started(fake)

      fake.server().message(agentMessage(2, 'third'))
      fake.server().message(userMessage(1, 'second'))

      expect(ready(session).items.map(({ id }) => id)).toEqual([1, 2])
    })

    it('thinks until text starts, streams it, and the finished message replaces it', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const session = await started(fake)

      fake.server().metadata(chat(0, 'Chat', 2, agentAuthor))
      expect(ready(session)).toMatchObject({ thinking: true, streamingText: '' })

      fake.server().stream(0, { type: 'textDelta', delta: 'Hel' })
      fake.server().stream(0, { type: 'textDelta', delta: 'lo' })
      expect(ready(session)).toMatchObject({ thinking: false, streamingText: 'Hello' })

      fake.server().message(agentMessage(1, 'Hello there'))
      expect(ready(session)).toMatchObject({ streamingText: '', items: [{ kind: 'assistant', text: 'Hello there' }] })
    })

    it('keeps the items array unchanged while text streams in', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]), { 0: page(userMessage(0, 'hi')) })
      const session = await started(fake)
      const before = ready(session).items

      fake.server().stream(0, { type: 'textDelta', delta: 'a' })
      fake.server().stream(0, { type: 'textDelta', delta: 'b' })

      expect(ready(session).items).toBe(before)
    })

    it('keeps streaming text when an older agent card changes', async () => {
      const action: AiChatMessage = { chatId: 0, sequence: 0, timestamp: new Date(0), author: agentAuthor, type: 'action', actionId: 1 }
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]), { 0: page(action, userMessage(1, 'continue')) })
      const session = await started(fake)
      fake.server().stream(0, { type: 'textDelta', delta: 'still writing' })
      fake.server().message(action)
      expect(ready(session).streamingText).toBe('still writing')
    })

    it('discards streamed text on a reset, and ignores stream events it does not show', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const session = await started(fake)

      fake.server().stream(0, { type: 'textDelta', delta: 'partial' })
      fake.server().stream(0, { type: 'reasoningDelta', delta: 'thinking about it' })
      expect(ready(session).streamingText).toBe('partial')

      fake.server().stream(0, { type: 'streamReset' })
      expect(ready(session).streamingText).toBe('')
    })

    it('when the agent stops, drops text that never became a message and reports the turn end', async () => {
      const onTurnEnded = vi.fn<() => void>()
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1, agentAuthor)]))
      const session = await started(fake, { onTurnEnded })

      fake.server().stream(0, { type: 'textDelta', delta: 'cut off' })
      fake.server().metadata(chat(0, 'Chat', 2))

      expect(ready(session)).toMatchObject({ streamingText: '', thinking: false })
      expect(onTurnEnded).toHaveBeenCalledOnce()
    })

    it('does not report a turn end for a title change', async () => {
      const onTurnEnded = vi.fn<() => void>()
      const fake = fakeOverseer(Promise.resolve([chat(0, 'New Chat', 1)]))
      const session = await started(fake, { onTurnEnded })

      fake.server().metadata(chat(0, 'Jira dashboard', 2))

      expect(ready(session).title).toBe('Jira dashboard')
      expect(onTurnEnded).not.toHaveBeenCalled()
    })

    it('ignores activity in the workspace’s other chats', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Old', 100), chat(1, 'Shown', 200)]))
      const session = await started(fake)

      fake.server().message(agentMessage(5, 'elsewhere', 0))
      fake.server().stream(0, { type: 'textDelta', delta: 'elsewhere' })
      fake.server().metadata(chat(0, 'Renamed old chat', 300, agentAuthor))

      expect(ready(session)).toMatchObject({ title: 'Shown', items: [], streamingText: '', thinking: false })
    })

    it('holds what arrives while still loading until it knows which chat is shown', async () => {
      const chats = deferred<AiChatMetadata[]>()
      const fake = fakeOverseer(chats.promise, { 1: page(userMessage(0, 'history', 1)) })
      const session = new ChatSession(() => fake.overseer)
      session.start()

      fake.server().message(agentMessage(7, 'for the other chat', 0))
      fake.server().message(agentMessage(1, 'for the shown chat', 1))
      chats.resolve([chat(0, 'Old', 100), chat(1, 'Shown', 200)])
      await settled(session)

      expect(ready(session).items).toMatchObject([
        { kind: 'user', text: 'history' },
        { kind: 'assistant', text: 'for the shown chat' },
      ])
    })

    it('adopts the first chat to report in when the workspace had none', async () => {
      const fake = fakeOverseer(Promise.resolve([]))
      const session = await started(fake)

      fake.server().metadata(chat(3, 'Created elsewhere', 1))
      fake.server().message(userMessage(0, 'hi', 3))
      fake.server().message(userMessage(0, 'not this one', 4))

      expect(ready(session)).toMatchObject({ title: 'Created elsewhere', items: [{ text: 'hi' }] })
    })

    it('discards streaming when the server instance changes, but not on a plain reconnect', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const session = await started(fake)

      fake.server().streamGeneration(1)
      fake.server().stream(0, { type: 'textDelta', delta: 'kept' })
      fake.server().streamGeneration(1)
      expect(ready(session).streamingText).toBe('kept')

      fake.server().streamGeneration(2)
      expect(ready(session).streamingText).toBe('')

      fake.server().stream(0, { type: 'textDelta', delta: 'x' })
      expect(ready(session).streamingText).toBe('x')
    })

    it('ignores activity after stop', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const session = await started(fake)
      const before = session.getSnapshot()

      session.stop()
      fake.server().message(userMessage(0, 'too late'))

      expect(session.getSnapshot()).toBe(before)
    })
  })

  describe('send', () => {
    it('sends into the chat that is shown', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(4, 'Chat', 1)]))
      const session = await started(fake)

      await session.send('hello', 'model-1')

      expect(fake.sendChatMessage).toHaveBeenCalledExactlyOnceWith(4, 'hello', 'model-1')
      expect(fake.newChat).not.toHaveBeenCalled()
      expect(ready(session).sendError).toBeUndefined()
    })

    it('starts a chat when the workspace has none, and adopts the events that arrive before it returns', async () => {
      const created = deferred<number>()
      const fake = fakeOverseer(Promise.resolve([]))
      fake.newChat.mockReturnValueOnce(created.promise)
      const session = await started(fake)

      const sending = session.send('first message', 'model-1')
      fake.server().message(userMessage(0, 'first message', 9))
      created.resolve(9)
      await sending

      expect(fake.newChat).toHaveBeenCalledExactlyOnceWith('first message', 'model-1')
      expect(ready(session).items).toMatchObject([{ kind: 'user', text: 'first message' }])

      await session.send('second', 'model-1')
      expect(fake.sendChatMessage).toHaveBeenCalledExactlyOnceWith(9, 'second', 'model-1')
    })

    it('reports a failed send, and clears the report on the next send', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      fake.sendChatMessage.mockRejectedValueOnce(new Error('The agent is still running.'))
      const session = await started(fake)

      await session.send('one', 'model-1')
      expect(ready(session).sendError).toBe('The agent is still running.')

      await session.send('two', 'model-1')
      expect(ready(session).sendError).toBeUndefined()
    })

    it('does nothing before the conversation has loaded', async () => {
      const chats = deferred<AiChatMetadata[]>()
      const fake = fakeOverseer(chats.promise)
      const session = new ChatSession(() => fake.overseer)
      session.start()

      await session.send('too early', 'model-1')

      expect(fake.sendChatMessage).not.toHaveBeenCalled()
      expect(fake.newChat).not.toHaveBeenCalled()
    })
  })

  describe('stop', () => {
    it('releases the workspace and the subscription, and drops a load that finishes afterwards', async () => {
      const chats = deferred<AiChatMetadata[]>()
      const fake = fakeOverseer(chats.promise, { 0: page(userMessage(0, 'late')) })
      const session = new ChatSession(() => fake.overseer)
      session.start()
      session.stop()
      await flush()
      expect(fake.dispose).toHaveBeenCalledOnce()
      expect(fake.leaseDispose).toHaveBeenCalledOnce()

      chats.resolve([chat(0, 'Late chat', 1)])
      await flush()
      expect(session.getSnapshot()).toEqual({ status: 'loading' })
    })

    it('does not dispose twice, and is harmless before start', async () => {
      const fake = fakeOverseer(Promise.resolve([]))
      const session = new ChatSession(() => fake.overseer)
      session.stop()
      expect(fake.dispose).not.toHaveBeenCalled()

      session.start()
      session.stop()
      session.stop()
      await flush()
      expect(fake.dispose).toHaveBeenCalledOnce()
      expect(fake.leaseDispose).toHaveBeenCalledOnce()
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
      const two = fakeOverseer(second.promise, { 5: page(userMessage(0, 'from the second run', 5)) })
      const overseers = [one.overseer, two.overseer]
      const session = new ChatSession(() => overseers.shift()!)

      session.start()
      session.stop()
      session.start()
      second.resolve([chat(5, 'Second', 1)])
      await settled(session)
      first.resolve([chat(0, 'First', 2)])
      await flush()

      expect(one.dispose).toHaveBeenCalledOnce()
      expect(two.dispose).not.toHaveBeenCalled()
      expect(ready(session)).toMatchObject({ title: 'Second' })
    })

    it('does not let the first run’s subscriber feed the second run', async () => {
      const one = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const two = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const overseers = [one.overseer, two.overseer]
      const session = new ChatSession(() => overseers.shift()!)

      session.start()
      session.stop()
      session.start()
      await settled(session)

      one.server().message(userMessage(0, 'from the stale subscription'))

      expect(ready(session).items).toEqual([])
    })
  })
})
