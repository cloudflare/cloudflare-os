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
  const uploadBlob = vi.fn<Overseer['uploadBlob']>(async (content) => `oid-${content.length}`)
  const asked = {
    retryAgent: vi.fn<Overseer['retryAgent']>(async () => {}),
    stopAgent: vi.fn<Overseer['stopAgent']>(async () => {}),
    approveAction: vi.fn<Overseer['approveAction']>(async () => {}),
    rejectAction: vi.fn<Overseer['rejectAction']>(async () => {}),
    denyConnectionRequest: vi.fn<Overseer['denyConnectionRequest']>(async () => {}),
    enableHook: vi.fn<Overseer['enableHook']>(async () => {}),
    disableHook: vi.fn<Overseer['disableHook']>(async () => {}),
    setChatTitle: vi.fn<Overseer['setChatTitle']>(async () => {}),
    listCollaborators: vi.fn<Overseer['listCollaborators']>(async () => []),
    mergeChanges: vi.fn<Overseer['mergeChanges']>(async () => ({ outcome: 'merged' })),
  }

  const overseer: ChatOverseer = {
    listChats,
    getChatHistory,
    subscribeToChat,
    subscribeToActions,
    sendChatMessage,
    uploadBlob,
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
    uploadBlob,
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

/** The user's messages in the conversation, with whether the agent has read each. */
const steers = (session: ChatSession) =>
  ready(session).items.flatMap((item) => (item.kind === 'user' ? [{ text: item.text, from: item.from, unread: item.unread, key: item.key }] : []))

/** A chat with one prompt, and a way to say which messages are waiting for its running agent. */
const steering = async () => {
  const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]), { 0: page(userMessage(0, 'go')) })
  const session = await started(fake, 0, { viewerId: 'u' })
  const queue = (...queuedSteers: NonNullable<AiChatMetadata['queuedSteers']>) =>
    fake.server().metadata({ ...chat(0, 'Chat', 2, agentAuthor), queuedSteers: queuedSteers.length ? queuedSteers : undefined })
  return { fake, session, queue }
}

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

/** A chat with changes waiting to gadget 1. */
const proposing = (activeAgent?: AiChatAuthorInfo): AiChatMetadata => ({ ...chat(0, 'Chat', 1, activeAgent), proposedChangeWorkpieces: [1] })
const changes = (sequence: number, extra: Partial<Extract<AiChatMessage, { type: 'changes' }>> = {}): AiChatMessage =>
  ({ chatId: 0, sequence, timestamp: new Date(0), author: agentAuthor, type: 'changes', ...extra })
const binding = { addedBindings: [{ gadgetId: 1, name: 'JIRA', target: 9 }] }

/**
 * A chat whose agent is working on gadget 1, and a way to end its turn. `earlier` are the pages
 * before `history`, newest first.
 */
const workingOn = async (history: AiChatMessage[], codeBase?: AiChatMetadata['codeBase'], earlier: AiChatHistoryPage[] = []) => {
  const fake = fakeOverseer(Promise.resolve([{ ...proposing(agentAuthor), codeBase }]))
  const pages = [{ messages: history, nextBeforeSequence: earlier.length > 0 ? history[0].sequence : undefined }, ...earlier]
  fake.getChatHistory.mockImplementation(async (_chatId, before) =>
    pages.find(({ messages }) => before === undefined || messages.every(({ sequence }) => sequence < before)) ?? page())
  const session = await started(fake)
  const endTurn = async () => {
    fake.listChats.mockResolvedValue([{ ...proposing(), codeBase }])
    fake.server().metadata({ ...proposing(), codeBase })
    await vi.waitFor(() => expect(fake.listCollaborators).toHaveBeenCalled())
    await flush()
  }
  return { fake, session, endTurn }
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

      expect(ready(session)).toMatchObject({ title: undefined, activity: undefined, items: [{ text: 'hello' }] })

      chats.resolve([chat(0, 'Chat', 1, agentAuthor)])
      await flush()
      expect(ready(session)).toMatchObject({ title: 'Chat', activity: 'Thinking…' })
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

      expect(ready(session)).toMatchObject({ title: 'Renamed', activity: 'Thinking…' })
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

    it('is thinking when an agent turn was already running', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1, agentAuthor)]))
      const session = await started(fake)

      expect(ready(session).activity).toBe('Thinking…')
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
      expect(ready(session)).toMatchObject({ hasEarlier: false, historyError: undefined, work: [{ type: 'writing', text: 'reply in progress' }] })
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

    it('thinks until text starts, is writing while it streams, and the finished message replaces it', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const session = await started(fake)

      fake.server().metadata(chat(0, 'Chat', 2, agentAuthor))
      expect(ready(session)).toMatchObject({ activity: 'Thinking…', work: [] })

      fake.server().stream(0, { type: 'textDelta', delta: 'Hel' })
      fake.server().stream(0, { type: 'textDelta', delta: 'lo' })
      expect(ready(session)).toMatchObject({ activity: 'Writing…', work: [{ type: 'writing', text: 'Hello' }] })

      fake.server().message(agentMessage(1, 'Hello there'))
      expect(ready(session)).toMatchObject({ work: [], items: [{ kind: 'assistant', text: 'Hello there' }] })
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
      expect(ready(session).work).toEqual([{ type: 'writing', key: 'live:writing', text: 'still writing' }])
    })

    it('discards what streamed of a reply on a reset', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const session = await started(fake)

      fake.server().stream(0, { type: 'textDelta', delta: 'partial' })
      fake.server().stream(0, { type: 'reasoningDelta', delta: 'thinking about it' })
      expect(ready(session).work).toMatchObject([{ type: 'thinking', text: 'thinking about it' }, { type: 'writing', text: 'partial' }])

      fake.server().stream(0, { type: 'streamReset' })
      expect(ready(session).work).toEqual([])
    })

    it('when the agent stops, drops text that never became a message and reports the turn end', async () => {
      const onTurnEnded = vi.fn<() => void>()
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1, agentAuthor)]))
      const session = await started(fake, 0, { onTurnEnded })

      fake.server().stream(0, { type: 'textDelta', delta: 'cut off' })
      fake.server().metadata(chat(0, 'Chat', 2))

      expect(ready(session)).toMatchObject({ work: [], activity: undefined })
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

      expect(ready(session)).toMatchObject({ title: 'Shown', items: [], work: [], activity: undefined })
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
      expect(ready(session).work).toMatchObject([{ type: 'writing', text: 'kept' }])

      fake.server().streamGeneration(2)
      expect(ready(session).work).toEqual([])

      fake.server().stream(0, { type: 'textDelta', delta: 'x' })
      expect(ready(session).work).toMatchObject([{ type: 'writing', text: 'x' }])
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

    it('shows reasoning as it is written', async () => {
      const { session, stream } = await working()
      expect(ready(session)).toMatchObject({ activity: 'Thinking…', work: [] })

      stream({ type: 'reasoningDelta', delta: 'The window is ' }, { type: 'reasoningDelta', delta: 'a constant.' })

      expect(ready(session)).toMatchObject({ activity: 'Thinking…', work: [{ type: 'thinking', text: 'The window is a constant.' }] })
    })

    it('says what a call is doing while it is written: what it is, its file, its content so far, and when its input is complete', async () => {
      const { session, stream } = await working()

      stream({ type: 'toolCallStarted', toolCallId: 'w', toolName: 'writeFile' })
      expect(ready(session)).toMatchObject({ activity: 'Writing file…', work: [{ label: 'Writing file…', running: true }] })

      stream({ type: 'toolCallTarget', toolCallId: 'w', file })
      stream({ type: 'editPreviewStart', toolCallId: 'w', file }, { type: 'editPreviewDelta', toolCallId: 'w', delta: 'export ' }, { type: 'editPreviewDelta', toolCallId: 'w', delta: 'default {}' })
      expect(ready(session)).toMatchObject({
        activity: 'Writing worker.ts…',
        work: [{ key: 'w', label: 'Writing worker.ts…', sections: [{ label: 'Content', text: 'export default {}' }] }],
      })

      stream({ type: 'toolCallFinished', toolCallId: 'w' })
      expect(ready(session).work).toMatchObject([{ running: false }])
    })

    it('streams the code a call runs, then its output', async () => {
      const { session, stream } = await working()

      stream(
        { type: 'toolCallStarted', toolCallId: 'x', toolName: 'executeCode' },
        { type: 'toolCodeDelta', toolCallId: 'x', delta: 'run(' },
        { type: 'toolCodeDelta', toolCallId: 'x', delta: ')' },
        { type: 'toolOutputDelta', toolCallId: 'x', delta: '42' },
      )

      expect(ready(session).work).toMatchObject([{
        label: 'Running code…',
        running: true,
        sections: [{ label: 'Code', text: 'run()' }, { label: 'Output', text: '42' }],
      }])
    })

    it('adds what is being written to the steps already taken', async () => {
      const { session, stream } = await working([userMessage(0, 'go'), withCalls(1, [read])])
      const before = ready(session)
      expect(before.work).toMatchObject([{ key: 'read', label: 'Read chart.tsx' }])

      stream({ type: 'textDelta', delta: 'Now the worker.' }, { type: 'toolCallStarted', toolCallId: 'e', toolName: 'editFile' }, { type: 'toolCallTarget', toolCallId: 'e', file })

      const after = ready(session)
      expect(after).toMatchObject({ activity: 'Editing worker.ts…', work: [{ key: 'read' }, { type: 'writing', text: 'Now the worker.' }, { key: 'e', running: true }] })
      expect(after.work[0]).toBe(before.work[0])
      expect(after.items).toBe(before.items)
    })

    it('keeps the thinking that led straight to a call with that call', async () => {
      const { session, stream } = await working()

      stream({ type: 'reasoningDelta', delta: 'Check the worker.' }, { type: 'toolCallStarted', toolCallId: 'r', toolName: 'readFile' })

      expect(ready(session).work).toMatchObject([{ type: 'call', reasoning: 'Check the worker.' }])
      expect(ready(session).work).toHaveLength(1)
    })

    it('replaces everything that streamed of a step with its durable message', async () => {
      const { session, stream, server } = await working([userMessage(0, 'go')])
      stream({ type: 'reasoningDelta', delta: 'Check it.' }, { type: 'toolCallStarted', toolCallId: 'read', toolName: 'readFile' }, { type: 'toolCallFinished', toolCallId: 'read' })
      const [live] = ready(session).work

      server.message(withCalls(1, [read], 'Check it.'))

      const snapshot = ready(session)
      expect(snapshot.activity).toBe('Thinking…')
      expect(snapshot.work).toEqual([expect.objectContaining({ key: live.key, label: 'Read chart.tsx', reasoning: 'Check it.' })])
      expect(snapshot.work[0]).not.toHaveProperty('running')
    })

    it('says the conversation is being compacted until that ends', async () => {
      const { session, stream } = await working()

      stream({ type: 'compacting' })
      expect(ready(session).activity).toBe('Compacting the conversation…')

      stream({ type: 'compacted' })
      expect(ready(session).activity).toBe('Thinking…')
    })

    it('discards all of a step that will be tried again: its text, reasoning and calls', async () => {
      const { session, stream } = await working([userMessage(0, 'go'), withCalls(1, [read])])
      stream(
        { type: 'reasoningDelta', delta: 'Hmm.' },
        { type: 'textDelta', delta: 'Partial' },
        { type: 'toolCallStarted', toolCallId: 'x', toolName: 'executeCode' },
        { type: 'toolCodeDelta', toolCallId: 'x', delta: 'run()' },
      )
      // What was done, then the step being written in its order: thought, reply, call.
      expect(ready(session).work.map(({ type }) => type)).toEqual(['call', 'thinking', 'writing', 'call'])

      stream({ type: 'streamReset' })

      expect(ready(session).activity).toBe('Thinking…')
      expect(ready(session).work).toEqual([expect.objectContaining({ key: 'read', label: 'Read chart.tsx' })])
    })

    it('drops what was streaming when the agent stops, and when the server restarts', async () => {
      const { session, stream, server } = await working()
      const streamStep = () => stream({ type: 'reasoningDelta', delta: 'Hmm.' }, { type: 'toolCallStarted', toolCallId: 'x', toolName: 'executeCode' }, { type: 'compacting' })

      server.streamGeneration(1)
      streamStep()
      server.streamGeneration(2)
      expect(ready(session)).toMatchObject({ work: [], activity: 'Thinking…' })

      streamStep()
      server.metadata(chat(0, 'Chat', 2))
      expect(ready(session)).toMatchObject({ work: [], activity: undefined })
    })

    it('keeps the turn’s steps only while it is worked on', async () => {
      const { session, server } = await working([userMessage(0, 'go'), withCalls(1, [read])])
      expect(ready(session).work).toHaveLength(1)

      server.message(agentMessage(2, 'Done'))
      server.metadata(chat(0, 'Chat', 2))

      expect(ready(session)).toMatchObject({ work: [], activity: undefined, items: [{ kind: 'user' }, { kind: 'assistant', text: 'Done' }] })
    })

    it('remembers what a streamed creation was making, for the card it becomes', async () => {
      const { session, stream, server } = await working([userMessage(0, 'write it up')])
      stream(
        { type: 'toolCallStarted', toolCallId: 'make', toolName: 'createGadget' },
        { type: 'toolCallOutputFormat', toolCallId: 'make', output: { id: 'document', noun: 'Document', plural: 'Documents', icon: 'fileText' } },
      )
      expect(ready(session)).toMatchObject({ activity: 'Creating Document…', work: [{ label: 'Creating Document…' }] })

      server.message(withCalls(1, [{ toolCallId: 'make', toolName: 'createGadget', input: { title: 'Review', bindingName: 'REVIEW' }, output: { gadgetId: 4 } }]))

      expect(ready(session)).toMatchObject({
        work: [],
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

    describe('messages sent to the running agent', () => {
      const grace = { type: 'user', id: 'g', name: 'Grace' } as const

      it('end the conversation unread, naming only other senders', async () => {
        const { session, queue } = await steering()

        queue({ text: 'Shorter', author: userAuthor }, { text: 'And in French', author: grace })

        expect(steers(session).slice(1)).toMatchObject([
          { text: 'Shorter', from: undefined, unread: true },
          { text: 'And in French', from: 'Grace', unread: true },
        ])
      })

      it('stay the same row once read: first as read, then as the message that arrives', async () => {
        const { fake, session, queue } = await steering()
        queue({ text: 'Shorter', author: userAuthor }, { text: 'And in French', author: grace })
        const [, shorter, french] = steers(session)

        // The agent read the first: it has left the queue, and its message has not arrived yet.
        queue({ text: 'And in French', author: grace })
        expect(steers(session).slice(1)).toEqual([{ ...shorter, unread: undefined }, french])

        fake.server().message({ ...userMessage(1, 'Shorter'), steered: true } as AiChatMessage)
        expect(steers(session).slice(1)).toEqual([{ ...shorter, unread: undefined }, french])
        expect(ready(session).items[1]).toMatchObject({ id: 1, key: shorter.key })
      })

      it('are not shown twice when the message arrives before the queue says it was read', async () => {
        const { fake, session, queue } = await steering()
        queue({ text: 'Shorter', author: userAuthor })

        fake.server().message({ ...userMessage(1, 'Shorter'), steered: true } as AiChatMessage)

        expect(steers(session).map(({ text, unread }) => [text, unread])).toEqual([['go', undefined], ['Shorter', undefined]])
      })

      it('are gone when the agent stops without reading them', async () => {
        const { fake, session, queue } = await steering()
        queue({ text: 'Shorter', author: userAuthor })

        fake.server().metadata(chat(0, 'Chat', 3))

        expect(steers(session).map(({ text }) => text)).toEqual(['go'])
      })

      it('are what stopping would drop, until the agent reads them', async () => {
        const { session, queue } = await steering()
        queue({ text: 'Shorter', author: userAuthor }, { text: 'And in French', author: grace })
        expect(ready(session).waiting).toEqual(['Shorter', 'And in French'])

        queue({ text: 'And in French', author: grace })
        expect(ready(session).waiting).toEqual(['And in French'])
      })
    })

    it('stops the running agent, and passes on a refusal', async () => {
      const { fake, session } = await steering()

      await session.stopAgent()
      expect(fake.stopAgent).toHaveBeenCalledExactlyOnceWith(0)

      fake.stopAgent.mockRejectedValueOnce(new Error('Gone'))
      await expect(session.stopAgent()).rejects.toThrow('Gone')
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
      expect(ready(session).items.at(-1)).toMatchObject({ kind: 'action', state: 'approved', resolution: 'Auto-approved (User’s rule)' })
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

    it('shows a new title at once, and puts the old one back when it is refused', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(4, 'Chat', 1)]))
      const session = await started(fake, 4)

      await session.rename('Q3 review')
      expect(fake.setChatTitle).toHaveBeenCalledExactlyOnceWith(4, 'Q3 review')
      expect(ready(session).title).toBe('Q3 review')

      fake.setChatTitle.mockRejectedValueOnce(new Error('No'))
      const refused = session.rename('Something else')
      expect(ready(session).title).toBe('Something else')
      await expect(refused).rejects.toThrow('No')
      expect(ready(session).title).toBe('Q3 review')
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

  describe('accepting changes on its own', () => {
    it('accepts the agent’s code when its turn ends', async () => {
      const { fake, endTurn } = await workingOn([userMessage(0, 'fix it'), changes(1)])
      expect(fake.mergeChanges).not.toHaveBeenCalled()

      await endTurn()
      expect(fake.mergeChanges).toHaveBeenCalledExactlyOnceWith(0)
    })

    it('accepts what was left proposed when the chat is opened', async () => {
      const fake = fakeOverseer(Promise.resolve([proposing()]), { 0: page(changes(1)) })
      await started(fake)
      await vi.waitFor(() => expect(fake.mergeChanges).toHaveBeenCalledExactlyOnceWith(0))
    })

    it('leaves the changes proposed when they bind a resource to the gadget', async () => {
      const { fake, endTurn } = await workingOn([changes(1, binding)])
      await endTurn()
      expect(fake.mergeChanges).not.toHaveBeenCalled()
    })

    it('leaves the changes proposed when someone else is in the workspace', async () => {
      const { fake, endTurn } = await workingOn([changes(1)])
      fake.listCollaborators.mockResolvedValue([{ profile: userAuthor, addedBy: [] }])
      await endTurn()
      expect(fake.mergeChanges).not.toHaveBeenCalled()
    })

    it('reads back to the last accept before deciding', async () => {
      // The binding is on a page before the one shown; the accept that opened the epoch is at 2.
      const { fake, endTurn } = await workingOn(
        [changes(5)],
        { pins: [], generation: 1, revision: 0, epoch: 2 },
        [{ messages: [changes(3, binding)], nextBeforeSequence: 3 }],
      )
      await endTurn()
      await vi.waitFor(() => expect(fake.getChatHistory).toHaveBeenCalledWith(0, 5, expect.any(Number)))
      await flush()

      expect(fake.getChatHistory).toHaveBeenCalledTimes(2)
      expect(fake.mergeChanges).not.toHaveBeenCalled()
    })

    it('reports an accept that failed', async () => {
      const { fake, session, endTurn } = await workingOn([changes(1)])
      fake.mergeChanges.mockRejectedValueOnce(new Error('Gadget is locked'))
      await endTurn()
      await vi.waitFor(() => expect(ready(session).actionError).toBe('The changes couldn’t be accepted: Gadget is locked'))
    })
  })

  describe('send', () => {
    it('sends into the chat that is shown', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(2, 'Other', 1), chat(4, 'Chat', 1)]))
      const session = await started(fake, 4)

      expect(await session.send('hello', 'model-1')).toBe(true)

      expect(fake.sendChatMessage).toHaveBeenCalledExactlyOnceWith(4, 'hello', 'model-1', undefined, undefined)
      expect(fake.uploadBlob).not.toHaveBeenCalled()
      expect(ready(session).sendError).toBeUndefined()
    })

    it('uploads the files, and sends them with the message', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const session = await started(fake)
      const files = [
        new File([Uint8Array.of(1, 2, 3)], 'chart.png', { type: 'image/png' }),
        new File(['notes'], 'notes.txt', { type: 'text/plain' }),
        new File([Uint8Array.of(0)], '', { type: '' }),
      ]

      await session.send('see these', 'model-1', files)

      expect(fake.uploadBlob.mock.calls.map(([content]) => [...content])).toEqual([[1, 2, 3], [...new TextEncoder().encode('notes')], [0]])
      expect(fake.sendChatMessage).toHaveBeenCalledExactlyOnceWith(0, 'see these', 'model-1', undefined, [
        { oid: 'oid-3', mimeType: 'image/png', name: 'chart.png' },
        { oid: 'oid-5', mimeType: 'text/plain', name: 'notes.txt' },
        { oid: 'oid-1', mimeType: 'application/octet-stream', name: undefined },
      ])
    })

    it('does not send the message when a file cannot be uploaded', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      fake.uploadBlob.mockRejectedValueOnce(new Error('Blob too large'))
      const session = await started(fake)

      // The draft is kept for a message that did not go.
      expect(await session.send('see this', 'model-1', [new File(['x'], 'x.txt')])).toBe(false)

      expect(fake.sendChatMessage).not.toHaveBeenCalled()
      expect(ready(session).sendError).toBe('Blob too large')
    })

    it('refuses files that are more than a message can carry, without uploading them', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      const session = await started(fake)

      expect(await session.send('', 'model-1', [new File([new Uint8Array(4 * 1024 * 1024 + 1)], 'huge.bin')])).toBe(false)
      expect(ready(session).sendError).toBe('huge.bin is larger than 4 MB, the most a file can be.')

      await session.send('', 'model-1', Array.from({ length: 6 }, (_, index) => new File(['x'], `${index}.txt`)))
      expect(ready(session).sendError).toBe('A message can carry up to 5 files.')

      expect(fake.uploadBlob).not.toHaveBeenCalled()
      expect(fake.sendChatMessage).not.toHaveBeenCalled()
    })

    it('holds files back while the agent works, which only plain text can steer', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1, agentAuthor)]))
      const session = await started(fake)

      expect(await session.send('and this', 'model-1', [new File(['x'], 'x.txt')])).toBe(false)

      expect(fake.uploadBlob).not.toHaveBeenCalled()
      expect(fake.sendChatMessage).not.toHaveBeenCalled()
      expect(ready(session).sendError).toBe('Files can be sent once the agent has finished.')
    })

    it('reports a failed send, and clears the report on the next send', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      fake.sendChatMessage.mockRejectedValueOnce(new Error('The agent is still running.'))
      const session = await started(fake)

      expect(await session.send('one', 'model-1')).toBe(false)
      expect(ready(session).sendError).toBe('The agent is still running.')

      expect(await session.send('two', 'model-1')).toBe(true)
      expect(ready(session).sendError).toBeUndefined()
    })

    it('puts the report of a failed send away when it is dismissed', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      fake.sendChatMessage.mockRejectedValueOnce(new Error('The agent is still running.'))
      const session = await started(fake)

      await session.send('one', 'model-1')
      session.dismissSendError()

      expect(ready(session).sendError).toBeUndefined()
    })

    it('does nothing before the conversation has loaded', async () => {
      const fake = fakeOverseer(Promise.resolve([chat(0, 'Chat', 1)]))
      fake.getChatHistory.mockReturnValueOnce(deferred<AiChatHistoryPage>().promise)
      const session = new ChatSession(() => fake.overseer, 0)
      session.start()

      expect(await session.send('too early', 'model-1')).toBe(false)

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
