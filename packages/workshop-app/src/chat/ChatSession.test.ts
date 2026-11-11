import { describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  ActionLogEntry,
  AiChatAuthorInfo,
  AiChatHistoryPage,
  AiChatMessage,
  AiChatMetadata,
  AiChatStreamEvent,
  AiToolCall,
  Overseer,
} from '@gadgets/workshop-shared/api'
import { ChatSession, type ChatOverseer, type ChatSnapshot } from './ChatSession'
import { ActionUpdates, ChatSubscriber } from './ChatSubscriber'

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

const actionMessage = (sequence: number, actionLog: ActionLogEntry): AiChatMessage =>
  ({ chatId: 0, sequence, timestamp: new Date(0), author: agentAuthor, type: 'action', actionId: actionLog.id, actionLog })

const page = (...messages: AiChatMessage[]): AiChatHistoryPage => ({ messages })

/** A workspace's Overseer, plus what a test needs to act as the server: the subscriber it was given. */
const fakeOverseer = (chats: Promise<AiChatMetadata[]>, histories: Record<number, AiChatHistoryPage> = {}) => {
  let subscriber: ChatSubscriber | undefined
  let actionUpdates: ActionUpdates | undefined
  const dispose = vi.fn<() => void>()
  const leaseDispose = vi.fn<() => void>()
  const actionsLeaseDispose = vi.fn<() => void>()
  // Only its disposer matters to the session.
  const lease = { [Symbol.dispose]: leaseDispose } as unknown as RpcStub<{}>
  const actionsLease = { [Symbol.dispose]: actionsLeaseDispose } as unknown as RpcStub<{}>

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
  const subscribeToActions = vi.fn<ChatOverseer['subscribeToActions']>((given) => {
    if (!(given instanceof ActionUpdates)) throw new Error('subscribeToActions was not given an ActionUpdates')
    actionUpdates = given
    return Promise.resolve(actionsLease)
  })
  const sendChatMessage = vi.fn<Overseer['sendChatMessage']>(async () => {})
  const asked = {
    retryAgent: vi.fn<Overseer['retryAgent']>(async () => {}),
    approveAction: vi.fn<Overseer['approveAction']>(async () => {}),
    rejectAction: vi.fn<Overseer['rejectAction']>(async () => {}),
    denyConnectionRequest: vi.fn<Overseer['denyConnectionRequest']>(async () => {}),
    enableHook: vi.fn<Overseer['enableHook']>(async () => {}),
    disableHook: vi.fn<Overseer['disableHook']>(async () => {}),
  }

  const overseer: ChatOverseer = {
    listChats,
    getChatHistory,
    subscribeToChat,
    subscribeToActions,
    sendChatMessage,
    ...asked,
    [Symbol.dispose]: dispose,
  }
  return {
    overseer,
    listChats,
    getChatHistory,
    subscribeToChat,
    subscribeToActions,
    sendChatMessage,
    ...asked,
    dispose,
    leaseDispose,
    actionsLeaseDispose,
    /** What the server calls with chat activity. */
    server: () => subscriber!,
    /** What the server calls when an action's record changes. */
    actions: () => actionUpdates!,
  }
}

const settled = (session: ChatSession) =>
  vi.waitFor(() => expect(session.getSnapshot().status).not.toBe('loading'))

const ready = (session: ChatSession) => {
  const snapshot: ChatSnapshot = session.getSnapshot()
  if (snapshot.status !== 'ready') throw new Error(`expected a ready session, got ${snapshot.status}`)
  return snapshot
}

const started = async (
  fake: ReturnType<typeof fakeOverseer>,
  chatId = 0,
  options?: ConstructorParameters<typeof ChatSession>[2],
) => {
  const session = new ChatSession(() => fake.overseer, chatId, options)
  session.start()
  await settled(session)
  // The chat list can land just after the history.
  await flush()
  return session
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

/** A chat whose agent is running, and a way to stream to it as the server does. */
const working = async (history: AiChatMessage[] = []) => {
  const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1, agentAuthor)]), { 0: page(...history) })
  const session = await started(fake)
  return { session, stream: (...events: AiChatStreamEvent[]) => events.forEach((event) => fake.server().stream(0, event)), server: fake.server() }
}
const withCalls = (sequence: number, toolCalls: AiToolCall[], reasoning?: string): AiChatMessage =>
  ({ chatId: 0, sequence, timestamp: new Date(0), author: agentAuthor, type: 'message', message: '', toolCalls, reasoning })

/** An action's record, pending unless `change` says otherwise. */
const log = (change: Partial<ActionLogEntry & { type: 'action' }> = {}): ActionLogEntry => ({
  id: 7,
  type: 'action',
  resourceTitle: 'Jira',
  createdAt: new Date(0),
  state: 'pending',
  description: { title: 'Create issue', description: '', implementsRevert: false },
  ...change,
})

/** A chat that ends with an action awaiting a decision (or with `actionLog`). */
const withAction = async (actionLog = log()) => {
  const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]), { 0: page(userMessage(0, 'file it'), actionMessage(1, actionLog)) })
  return { fake, session: await started(fake) }
}

describe('ChatSession', () => {
  describe('loading', () => {
    it('shows the chat it was opened on: its title and messages', async () => {
      const fake = fakeOverseer(
        Promise.resolve([chat(0, 'Old chat', 100), chat(1, 'Opened chat', 50), chat(2, 'Newest chat', 300)]),
        { 1: page(userMessage(0, 'hello', 1)) },
      )
      const session = await started(fake, 1)

      expect(fake.getChatHistory).toHaveBeenCalledExactlyOnceWith(1, undefined, 50)
      expect(ready(session)).toMatchObject({ title: 'Opened chat', items: [{ kind: 'user', text: 'hello' }] })
    })

    it('reports a chat that is not in the workspace', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Other chat', 1)]))
      const session = await started(fake, 3)

      expect(session.getSnapshot()).toEqual({ status: 'failed', message: 'This chat doesn’t exist, or was deleted.' })
    })

    it('shows the messages before the chat list arrives, then the title and agent state', async () => {
      const chats = deferred<AiChatMetadata[]>()
      const fake = fakeOverseer(chats.promise, { 0: page(userMessage(0, 'hello')) })
      const session = new ChatSession(() => fake.overseer, 0)
      session.start()
      await settled(session)

      expect(ready(session)).toMatchObject({ title: undefined, thinking: false, items: [{ text: 'hello' }] })

      chats.resolve([chat(0, 'Chat', 1, agentAuthor)])
      await flush()
      expect(ready(session)).toMatchObject({ title: 'Chat', thinking: true })
    })

    it('keeps a live metadata update over the listed metadata that arrives after it', async () => {
      const chats = deferred<AiChatMetadata[]>()
      const fake = fakeOverseer(chats.promise)
      const session = new ChatSession(() => fake.overseer, 0)
      session.start()
      await settled(session)

      fake.server().metadata(chat(0, 'Renamed', 2, agentAuthor))
      chats.resolve([chat(0, 'Old title', 1)])
      await flush()

      expect(ready(session)).toMatchObject({ title: 'Renamed', thinking: true })
    })

    it('reports why loading failed', async () => {
      const fake = fakeOverseer(Promise.reject(new Error("You don't have access to this workspace.")))
      const session = await started(fake)

      expect(session.getSnapshot()).toEqual({ status: 'failed', message: "You don't have access to this workspace." })
    })

    it('reports a subscription that cannot be made', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      fake.subscribeToChat.mockReturnValueOnce(Promise.reject(new Error('subscription refused')))
      const session = await started(fake)

      expect(session.getSnapshot()).toEqual({ status: 'failed', message: 'subscription refused' })
    })

    it('reports an actions subscription that cannot be made', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      fake.subscribeToActions.mockReturnValueOnce(Promise.reject(new Error('actions refused')))
      const session = await started(fake)

      expect(session.getSnapshot()).toEqual({ status: 'failed', message: 'actions refused' })
    })

    it('subscribes before it reads anything, so nothing in between is missed', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      await started(fake)

      expect(fake.subscribeToChat.mock.invocationCallOrder[0]).toBeLessThan(fake.listChats.mock.invocationCallOrder[0])
      expect(fake.subscribeToActions.mock.invocationCallOrder[0]).toBeLessThan(fake.listChats.mock.invocationCallOrder[0])
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
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const session = new ChatSession(() => fake.overseer, 0)
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
      const session = await started(fake, 0, { onTurnEnded })

      fake.server().stream(0, { type: 'textDelta', delta: 'cut off' })
      fake.server().metadata(chat(0, 'Chat', 2))

      expect(ready(session)).toMatchObject({ streamingText: '', thinking: false })
      expect(onTurnEnded).toHaveBeenCalledOnce()
    })

    it('does not report a turn end for a title change', async () => {
      const onTurnEnded = vi.fn<() => void>()
      const fake = fakeOverseer(Promise.resolve([chat(0, 'New Chat', 1)]))
      const session = await started(fake, 0, { onTurnEnded })

      fake.server().metadata(chat(0, 'Jira dashboard', 2))

      expect(ready(session).title).toBe('Jira dashboard')
      expect(onTurnEnded).not.toHaveBeenCalled()
    })

    it('ignores activity in the workspace’s other chats', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Other', 200), chat(1, 'Shown', 100)]))
      const session = await started(fake, 1)

      fake.server().message(agentMessage(5, 'elsewhere', 0))
      fake.server().stream(0, { type: 'textDelta', delta: 'elsewhere' })
      fake.server().metadata(chat(0, 'Renamed old chat', 300, agentAuthor))

      expect(ready(session)).toMatchObject({ title: 'Shown', items: [], streamingText: '', thinking: false })
    })

    it('holds what arrives while still loading, and applies it over the history', async () => {
      const history = deferred<AiChatHistoryPage>()
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Other', 200), chat(1, 'Shown', 100)]))
      fake.getChatHistory.mockReturnValueOnce(history.promise)
      const session = new ChatSession(() => fake.overseer, 1)
      session.start()

      fake.server().message(agentMessage(7, 'for the other chat', 0))
      fake.server().message(agentMessage(1, 'for the shown chat', 1))
      history.resolve(page(userMessage(0, 'history', 1)))
      await settled(session)

      expect(ready(session).items).toMatchObject([
        { kind: 'user', text: 'history' },
        { kind: 'assistant', text: 'for the shown chat' },
      ])
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

  describe('a step as it streams', () => {
    const file = { workpieceId: 1, filename: 'worker.ts' }
    const read: AiToolCall = { toolCallId: 'read', toolName: 'readFile', input: { filename: 'chart.tsx' } }

    it('shows reasoning as it is written, which is no longer just thinking', async () => {
      const { session, stream } = await working()
      expect(ready(session)).toMatchObject({ thinking: true, streamingReasoning: '' })

      stream({ type: 'reasoningDelta', delta: 'The window is ' }, { type: 'reasoningDelta', delta: 'a constant.' })

      expect(ready(session)).toMatchObject({ thinking: false, streamingReasoning: 'The window is a constant.', streamingText: '' })
    })

    it('lists a call while it is written: what it is, its file, its content so far, and when its input is complete', async () => {
      const { session, stream } = await working()

      stream({ type: 'toolCallStarted', toolCallId: 'w', toolName: 'writeFile' })
      expect(ready(session)).toMatchObject({ thinking: false, openTools: { running: true, entries: [{ label: 'Writing file…', running: true }] } })

      stream({ type: 'toolCallTarget', toolCallId: 'w', file })
      stream({ type: 'editPreviewStart', toolCallId: 'w', file }, { type: 'editPreviewDelta', toolCallId: 'w', delta: 'export ' }, { type: 'editPreviewDelta', toolCallId: 'w', delta: 'default {}' })
      expect(ready(session).openTools).toMatchObject({
        summary: 'Writing worker.ts…',
        entries: [{ key: 'w', label: 'Writing worker.ts…', sections: [{ label: 'Content', text: 'export default {}' }] }],
      })

      stream({ type: 'toolCallFinished', toolCallId: 'w' })
      expect(ready(session).openTools?.entries).toMatchObject([{ running: false }])
    })

    it('streams the code a call runs, then its output', async () => {
      const { session, stream } = await working()

      stream(
        { type: 'toolCallStarted', toolCallId: 'x', toolName: 'executeCode' },
        { type: 'toolCodeDelta', toolCallId: 'x', delta: 'run(' },
        { type: 'toolCodeDelta', toolCallId: 'x', delta: ')' },
        { type: 'toolOutputDelta', toolCallId: 'x', delta: '42' },
      )

      expect(ready(session).openTools?.entries).toMatchObject([{
        label: 'Running code…',
        running: true,
        sections: [{ label: 'Code', text: 'run()' }, { label: 'Output', text: '42' }],
      }])
    })

    it('adds live calls to the run of calls the turn already ends with, under the same key', async () => {
      const { session, stream } = await working([userMessage(0, 'go'), withCalls(1, [read])])
      const before = ready(session)
      expect(before.openTools).toMatchObject({ summary: 'Read chart.tsx', entries: [{ key: 'read' }] })

      stream({ type: 'toolCallStarted', toolCallId: 'e', toolName: 'editFile' }, { type: 'toolCallTarget', toolCallId: 'e', file })

      const after = ready(session)
      expect(after.openTools).toMatchObject({ key: before.openTools!.key, running: true, summary: 'Editing worker.ts…', entries: [{ key: 'read' }, { key: 'e', running: true }] })
      expect(after.streamingTools).toBeUndefined()
      expect(after.items).toBe(before.items)
    })

    it('starts a new run for calls that follow text the agent is writing', async () => {
      const { session, stream } = await working([userMessage(0, 'go'), withCalls(1, [read])])

      stream({ type: 'textDelta', delta: 'Now the worker.' }, { type: 'toolCallStarted', toolCallId: 'e', toolName: 'editFile' })

      expect(ready(session)).toMatchObject({
        openTools: { entries: [{ key: 'read' }] },
        streamingText: 'Now the worker.',
        streamingTools: { entries: [{ key: 'e' }] },
      })
      expect(ready(session).openTools?.running).toBeUndefined()
    })

    it('keeps the thinking that led straight to a call with that call', async () => {
      const { session, stream } = await working()

      stream({ type: 'reasoningDelta', delta: 'Check the worker.' }, { type: 'toolCallStarted', toolCallId: 'r', toolName: 'readFile' })

      expect(ready(session)).toMatchObject({ streamingReasoning: '', openTools: { entries: [{ reasoning: 'Check the worker.' }] } })
    })

    it('replaces everything that streamed of a step with its durable message', async () => {
      const { session, stream, server } = await working([userMessage(0, 'go')])
      stream({ type: 'reasoningDelta', delta: 'Check it.' }, { type: 'toolCallStarted', toolCallId: 'read', toolName: 'readFile' }, { type: 'toolCallFinished', toolCallId: 'read' })
      const live = ready(session).openTools!

      server.message(withCalls(1, [read], 'Check it.'))

      const snapshot = ready(session)
      expect(snapshot).toMatchObject({ streamingReasoning: '', streamingTools: undefined, openTools: { key: live.key, summary: 'Read chart.tsx' } })
      expect(snapshot.openTools?.running).toBeUndefined()
      expect(snapshot.openTools?.entries).toMatchObject([{ label: 'Read chart.tsx', reasoning: 'Check it.' }])
    })

    it('says the conversation is being compacted until that ends', async () => {
      const { session, stream } = await working()

      stream({ type: 'compacting' })
      expect(ready(session)).toMatchObject({ compacting: true, thinking: false })

      stream({ type: 'compacted' })
      expect(ready(session)).toMatchObject({ compacting: false, thinking: true })
    })

    it('discards all of a step that will be tried again: its text, reasoning and calls', async () => {
      const { session, stream } = await working([userMessage(0, 'go'), withCalls(1, [read])])
      stream(
        { type: 'reasoningDelta', delta: 'Hmm.' },
        { type: 'textDelta', delta: 'Partial' },
        { type: 'toolCallStarted', toolCallId: 'x', toolName: 'executeCode' },
        { type: 'toolCodeDelta', toolCallId: 'x', delta: 'run()' },
      )
      expect(ready(session).streamingTools).toBeDefined()

      stream({ type: 'streamReset' })

      expect(ready(session)).toMatchObject({ streamingReasoning: '', streamingText: '', streamingTools: undefined, thinking: true })
      expect(ready(session).openTools).toMatchObject({ summary: 'Read chart.tsx', entries: [{ key: 'read' }] })
    })

    it('drops what was streaming when the agent stops, and when the server restarts', async () => {
      const { session, stream, server } = await working()
      const streamStep = () => stream({ type: 'reasoningDelta', delta: 'Hmm.' }, { type: 'toolCallStarted', toolCallId: 'x', toolName: 'executeCode' }, { type: 'compacting' })

      server.streamGeneration(1)
      streamStep()
      server.streamGeneration(2)
      expect(ready(session)).toMatchObject({ openTools: undefined, streamingReasoning: '', compacting: false })

      streamStep()
      server.metadata(chat(0, 'Chat', 2))
      expect(ready(session)).toMatchObject({ openTools: undefined, streamingReasoning: '', compacting: false, thinking: false })
    })

    it('remembers what a streamed creation was making, for the card it becomes', async () => {
      const { session, stream, server } = await working([userMessage(0, 'write it up')])
      stream(
        { type: 'toolCallStarted', toolCallId: 'make', toolName: 'createGadget' },
        { type: 'toolCallOutputFormat', toolCallId: 'make', output: { id: 'document', noun: 'Document', plural: 'Documents', icon: 'fileText' } },
      )
      expect(ready(session).openTools?.entries).toMatchObject([{ label: 'Creating Document…' }])

      server.message(withCalls(1, [{ toolCallId: 'make', toolName: 'createGadget', input: { title: 'Review', bindingName: 'REVIEW' }, output: { gadgetId: 4 } }]))

      expect(ready(session)).toMatchObject({
        openTools: undefined,
        pinned: [{ kind: 'output', title: 'Review', workpieceId: 4, draft: true, format: { noun: 'Document', icon: 'fileText' } }],
      })
    })
  })

  describe('the open turn', () => {
    it('keeps what the turn produced apart from its rows, and moves it into them when the next turn starts', async () => {
      const hook: AiChatMessage = {
        chatId: 0,
        sequence: 1,
        timestamp: new Date(0),
        author: agentAuthor,
        type: 'action',
        actionId: 3,
        actionLog: { id: 3, type: 'bindHook', resourceTitle: 'Jira', createdAt: new Date(0), state: 'approved', description: { title: 'New issue', description: '' }, hookId: 1, enabled: true },
      }
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]), { 0: page(userMessage(0, 'watch it'), hook, agentMessage(2, 'Watching.')) })
      const session = await started(fake)
      expect(ready(session).items.map(({ kind }) => kind)).toEqual(['user', 'assistant'])
      expect(ready(session).pinned).toMatchObject([{ kind: 'hook', title: 'New issue' }])

      fake.server().message(userMessage(3, 'thanks'))

      expect(ready(session).items.map(({ kind }) => kind)).toEqual(['user', 'assistant', 'hook', 'user'])
      expect(ready(session).pinned).toEqual([])
    })

    it('lists the messages waiting for the running agent, naming only other senders', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const session = await started(fake, 0, { viewerId: 'u' })

      fake.server().metadata({
        ...chat(0, 'Chat', 2, agentAuthor),
        queuedSteers: [{ text: 'Shorter', author: userAuthor }, { text: 'And in French', author: { type: 'user', id: 'g', name: 'Grace' } }],
      })
      expect(ready(session).queuedSteers).toEqual([{ text: 'Shorter', from: undefined }, { text: 'And in French', from: 'Grace' }])

      fake.server().metadata(chat(0, 'Chat', 3, agentAuthor))
      expect(ready(session).queuedSteers).toEqual([])
    })

    it('offers to retry the last error only once the agent has stopped', async () => {
      const failed: AiChatMessage = { chatId: 0, sequence: 1, timestamp: new Date(0), author: agentAuthor, type: 'error', message: 'Overloaded' }
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1, agentAuthor)]), { 0: page(userMessage(0, 'go'), failed) })
      const session = await started(fake)
      expect(ready(session).items.at(-1)).toMatchObject({ kind: 'error', recovery: undefined })

      fake.server().metadata(chat(0, 'Chat', 2))
      expect(ready(session).items.at(-1)).toMatchObject({ kind: 'error', recovery: 'retry' })
    })

    it('marks where the context was cut when the chat says so', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]), { 0: page(userMessage(0, 'old'), agentMessage(1, 'old answer'), userMessage(2, 'new')) })
      const session = await started(fake)

      fake.server().metadata({ ...chat(0, 'Chat', 2), compactedTo: 2 })

      expect(ready(session).items.map(({ kind }) => kind)).toEqual(['user', 'assistant', 'divider', 'user'])
    })
  })

  describe('what a row asks for', () => {
    it('approves through the workspace, and shows the decision when the action’s record says so', async () => {
      const { fake, session } = await withAction()
      expect(ready(session).pinned).toMatchObject([{ kind: 'action', actionId: 7, state: 'pending' }])

      await session.approveAction(7)
      expect(fake.approveAction).toHaveBeenCalledExactlyOnceWith(7)
      // Nothing is assumed: the card changes only when the workspace reports the record.
      expect(ready(session).pinned).toMatchObject([{ state: 'pending' }])

      fake.actions().entry(log({ state: 'approved', resolvedBy: userAuthor }))
      expect(ready(session).pinned).toEqual([])
      expect(ready(session).items.at(-1)).toMatchObject({ kind: 'action', state: 'approved', resolution: 'Approved by User' })
    })

    it('denies through the workspace', async () => {
      const { fake, session } = await withAction()

      await session.rejectAction(7)
      fake.actions().entry(log({ state: 'rejected', resolvedBy: userAuthor }))

      expect(fake.rejectAction).toHaveBeenCalledExactlyOnceWith(7)
      expect(ready(session).items.at(-1)).toMatchObject({ kind: 'action', state: 'denied' })
    })

    it('stops asking when a rule approves the action instead', async () => {
      const { fake, session } = await withAction()

      fake.actions().entry(log({ state: 'approved', resolvedBy: userAuthor, autoApproved: true }))

      expect(ready(session).pinned).toEqual([])
      expect(ready(session).openTools?.entries).toMatchObject([{ type: 'action', resolution: 'Auto-approved (User’s rule)' }])
    })

    it('ignores a record no loaded message shows', async () => {
      const { fake, session } = await withAction()
      const before = session.getSnapshot()

      fake.actions().entry(log({ id: 99, state: 'approved' }))

      expect(session.getSnapshot()).toBe(before)
    })

    it('switches a hook on and off, following the record for its state', async () => {
      const hook: ActionLogEntry = { id: 7, type: 'bindHook', resourceTitle: 'Jira', createdAt: new Date(0), state: 'approved', description: { title: 'New issue', description: '' }, hookId: 3, enabled: true }
      const { fake, session } = await withAction(hook)

      await session.setHookEnabled(3, false)
      expect(fake.disableHook).toHaveBeenCalledExactlyOnceWith(3)
      fake.actions().entry({ ...hook, enabled: false })
      expect(ready(session).pinned).toMatchObject([{ kind: 'hook', enabled: false }])

      await session.setHookEnabled(3, true)
      expect(fake.enableHook).toHaveBeenCalledExactlyOnceWith(3)
    })

    it('retries the chat it shows, and denies a connection request', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(2, 'Other', 1), chat(4, 'Chat', 1)]))
      const session = await started(fake, 4)

      await session.retry('model-1')
      await session.denyConnection('request-1')

      expect(fake.retryAgent).toHaveBeenCalledExactlyOnceWith(4, 'model-1')
      expect(fake.denyConnectionRequest).toHaveBeenCalledExactlyOnceWith('request-1')
    })

    it('reports what could not be done, until the next thing is asked', async () => {
      const { fake, session } = await withAction()
      fake.approveAction.mockRejectedValueOnce(new Error('Action is not pending: 7'))

      await session.approveAction(7)
      expect(ready(session).actionError).toBe('Action is not pending: 7')

      await session.rejectAction(7)
      expect(ready(session).actionError).toBeUndefined()
    })
  })

  describe('send', () => {
    it('sends into the chat that is shown', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(2, 'Other', 1), chat(4, 'Chat', 1)]))
      const session = await started(fake, 4)

      await session.send('hello', 'model-1')

      expect(fake.sendChatMessage).toHaveBeenCalledExactlyOnceWith(4, 'hello', 'model-1')
      expect(ready(session).sendError).toBeUndefined()
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
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      fake.getChatHistory.mockReturnValueOnce(deferred<AiChatHistoryPage>().promise)
      const session = new ChatSession(() => fake.overseer, 0)
      session.start()

      await session.send('too early', 'model-1')

      expect(fake.sendChatMessage).not.toHaveBeenCalled()
    })
  })

  describe('stop', () => {
    it('releases the workspace and the subscription, and drops a load that finishes afterwards', async () => {
      const chats = deferred<AiChatMetadata[]>()
      const history = deferred<AiChatHistoryPage>()
      const fake = fakeOverseer(chats.promise)
      fake.getChatHistory.mockReturnValueOnce(history.promise)
      const session = new ChatSession(() => fake.overseer, 0)
      session.start()
      session.stop()
      await flush()
      expect(fake.dispose).toHaveBeenCalledOnce()
      expect(fake.leaseDispose).toHaveBeenCalledOnce()
      expect(fake.actionsLeaseDispose).toHaveBeenCalledOnce()

      history.resolve(page(userMessage(0, 'late')))
      chats.resolve([chat(0, 'Late chat', 1)])
      await flush()
      expect(session.getSnapshot()).toEqual({ status: 'loading' })
    })

    it('does not dispose twice, and is harmless before start', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const session = new ChatSession(() => fake.overseer, 0)
      session.stop()
      expect(fake.dispose).not.toHaveBeenCalled()

      session.start()
      session.stop()
      session.stop()
      await flush()
      expect(fake.dispose).toHaveBeenCalledOnce()
      expect(fake.leaseDispose).toHaveBeenCalledOnce()
      expect(fake.actionsLeaseDispose).toHaveBeenCalledOnce()
    })

    it('opens nothing for a session that was never started', () => {
      const open = vi.fn<() => ChatOverseer>()
      const session = new ChatSession(open, 0)
      expect(open).not.toHaveBeenCalled()
      expect(session.getSnapshot()).toEqual({ status: 'loading' })
    })
  })

  describe('restart (React runs an effect, its cleanup, then the effect again in development)', () => {
    it('ignores the first run when it finishes after the second has started', async () => {
      const first = deferred<AiChatMetadata[]>()
      const second = deferred<AiChatMetadata[]>()
      const one = fakeOverseer(first.promise, { 0: page(userMessage(0, 'from the first run')) })
      const two = fakeOverseer(second.promise, { 0: page(userMessage(0, 'from the second run')) })
      const overseers = [one.overseer, two.overseer]
      const session = new ChatSession(() => overseers.shift()!, 0)

      session.start()
      session.stop()
      session.start()
      second.resolve([chat(0, 'Second', 1)])
      await settled(session)
      first.resolve([chat(0, 'First', 2)])
      await flush()

      expect(one.dispose).toHaveBeenCalledOnce()
      expect(two.dispose).not.toHaveBeenCalled()
      expect(ready(session)).toMatchObject({ title: 'Second', items: [{ text: 'from the second run' }] })
    })

    it('does not let the first run’s subscriber feed the second run', async () => {
      const one = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const two = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const overseers = [one.overseer, two.overseer]
      const session = new ChatSession(() => overseers.shift()!, 0)

      session.start()
      session.stop()
      session.start()
      await settled(session)

      one.server().message(userMessage(0, 'from the stale subscription'))

      expect(ready(session).items).toEqual([])
    })
  })
})
