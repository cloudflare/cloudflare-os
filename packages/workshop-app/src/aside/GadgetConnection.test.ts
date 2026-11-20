import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ACCESS_CONFIRMATION_ERROR_CODES, createAccessConfirmationError, type AiChatAuthorInfo, type AiChatMetadata, type ConsoleLogEvent, type AiChatSubscriber, type PresenceSubscriber, type UiBundle, type WorkpieceSummary, type WorkpiecesSubscriber } from '@gadgets/workshop-shared/api'
import { GadgetConnection, type GadgetHandle, type GadgetOverseer, type GadgetUi } from './GadgetConnection'
import { pipelined } from '@/chat/mock/pipelined'

// The root each page's session was given, in place of a real session over the port.
const roots: object[] = []
vi.mock('capnweb', async (actual) => ({
  ...(await actual<typeof import('capnweb')>()),
  newMessagePortRpcSession: (_port: MessagePort, root: object) => {
    roots.push(root)
    return { [Symbol.dispose]: () => {} }
  },
}))

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const person = (id: string): AiChatAuthorInfo => ({ type: 'user', id, name: id.toUpperCase() })
const chat = (generation: number): AiChatMetadata => ({ id: 3, title: 'Chat', started: new Date(0), lastActive: new Date(0), codeBase: { pins: [], generation, revision: 0 } })
const head = (commitId: string, title = 'Review'): WorkpieceSummary => ({ id: 41, type: 'gadget', title, commitId } as WorkpieceSummary)

// What the connection listens to: the page's messages arrive on the window.
let received: ((event: Partial<MessageEvent>) => void) | undefined
beforeEach(() => {
  vi.stubGlobal('window', {
    addEventListener: (_: string, listener: typeof received) => (received = listener),
    removeEventListener: () => (received = undefined),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  received = undefined
  roots.length = 0
})

const setUp = ({ bundle = Promise.resolve<UiBundle | null>({ jsCode: 'render()' }) } = {}) => {
  const disposed: string[] = []
  const servers: { [Symbol.dispose]: () => void }[] = []
  const lease = (name: string) => ({ [Symbol.dispose]: () => disposed.push(name) })
  // Whoever is told when a stub breaks, by the stub's name.
  const onBroken = new Map<string, Array<(error: unknown) => void>>()
  const breakable = (name: string) => ({
    ...lease(name),
    onRpcBroken: (callback: (error: unknown) => void) => void onBroken.set(name, [...(onBroken.get(name) ?? []), callback]),
  })
  let presence: PresenceSubscriber | undefined
  let chats: AiChatSubscriber | undefined
  let workpieces: WorkpiecesSubscriber | undefined
  const gadget: GadgetHandle = {
    getUiBundle: vi.fn<GadgetHandle['getUiBundle']>(() => bundle),
    connectToGadget: vi.fn<GadgetHandle['connectToGadget']>(() => {
      const server = breakable(`server ${servers.length}`)
      servers.push(server)
      return pipelined(Promise.resolve(server))
    }),
    ...breakable('gadget'),
  }
  const overseer: GadgetOverseer = {
    getGadget: vi.fn<GadgetOverseer['getGadget']>(() => gadget),
    subscribeToPresence: async (subscriber) => {
      presence = subscriber as unknown as PresenceSubscriber
      return lease('presence')
    },
    subscribeToChat: async (subscriber) => {
      chats = subscriber as unknown as AiChatSubscriber
      return lease('chat')
    },
    subscribeToWorkpieces: async (subscriber) => {
      workpieces = subscriber as unknown as WorkpiecesSubscriber
      return lease('workpieces')
    },
    ...breakable('overseer'),
  }
  const onEscape = vi.fn<() => void>()
  const onConsoleLog = vi.fn<(log: ConsoleLogEvent) => void>()
  const onPointerAt = vi.fn<(y: number) => void>()
  const connection = new GadgetConnection(() => overseer, 41, { chatId: 3, viewerId: 'me', onEscape, onConsoleLog, onPointerAt })
  const frame = {} as Window
  connection.showIn(() => frame)
  /** The stub named `name` can no longer reach what it did, as when the workspace restarted. */
  const breaks = (name: string) => onBroken.get(name)?.forEach((callback) => callback(new Error('Durable Object reset')))
  return { connection, overseer, gadget, frame, disposed, onEscape, onConsoleLog, onPointerAt, links: () => roots, breaks, presence: () => presence!, chats: () => chats!, workpieces: () => workpieces! }
}

const handshake = (source: unknown, origin = 'null') => {
  const { port1 } = new MessageChannel()
  received!({ source: source as Window, origin, data: 'handshake', ports: [port1] })
  return port1
}

describe('GadgetConnection', () => {
  it('loads the gadget’s UI, with the changes of the chat it was opened from, into a page', async () => {
    const { connection, overseer, gadget } = setUp()
    connection.start()
    expect(connection.getSnapshot().ui).toEqual({ status: 'loading' })
    await vi.waitFor(() => expect(connection.getSnapshot().ui.status).toBe('ready'))
    expect(overseer.getGadget).toHaveBeenCalledWith(41)
    expect(gadget.getUiBundle).toHaveBeenCalledWith(3)
    const ui = connection.getSnapshot().ui
    // Each module of the bundle is a data: URL in the page's import map.
    expect(ui.status === 'ready' && ui.page).toContain(btoa('render()\n//# sourceURL=client.js'))
    connection.stop()
  })

  it('says when the gadget has no UI, and why one could not be loaded', async () => {
    const empty = setUp({ bundle: Promise.resolve(null) })
    empty.connection.start()
    await vi.waitFor(() => expect(empty.connection.getSnapshot().ui).toEqual({ status: 'none' }))
    empty.connection.stop()

    const broken = setUp({ bundle: Promise.reject(new Error('No such gadget')) })
    broken.connection.start()
    await vi.waitFor(() => expect(broken.connection.getSnapshot().ui).toEqual({ status: 'failed', message: 'No such gadget' }))
    broken.connection.stop()
  })

  it('tells a gadget the user did not confirm their access to by its code, not its message', async () => {
    const refusal = Object.assign(createAccessConfirmationError(ACCESS_CONFIRMATION_ERROR_CODES.cancelled, { workspaceId: 'ws', gadgetId: 41 }), { message: 'Reworded' })
    const unconfirmed = setUp({ bundle: Promise.reject(refusal) })
    unconfirmed.connection.start()
    await vi.waitFor(() => expect(unconfirmed.connection.getSnapshot().ui).toEqual({ status: 'unconfirmed' }))
    unconfirmed.connection.stop()
  })

  it('connects only the page in its own frame, which has no origin', async () => {
    const { connection, gadget, frame } = setUp()
    connection.start()
    handshake({})
    handshake(frame, 'https://example.com')
    await Promise.resolve()
    expect(gadget.connectToGadget).not.toHaveBeenCalled()

    handshake(frame)
    await vi.waitFor(() => expect(gadget.connectToGadget).toHaveBeenCalledWith(3))
    connection.stop()
  })

  it('lets go of a connection the page no longer needs: one overtaken by a reload, and the last on stopping', async () => {
    const { connection, gadget, frame, disposed } = setUp()
    connection.start()
    const pending = deferred<Awaited<ReturnType<GadgetHandle['connectToGadget']>>>()
    vi.mocked(gadget.connectToGadget).mockReturnValueOnce(pipelined(pending.promise))
    handshake(frame)
    connection.reload()
    pending.resolve({ [Symbol.dispose]: () => disposed.push('overtaken'), onRpcBroken: () => {} })
    await vi.waitFor(() => expect(disposed).toContain('overtaken'))

    handshake(frame)
    await vi.waitFor(() => expect(gadget.connectToGadget).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    connection.stop()
    await vi.waitFor(() => expect(disposed).toEqual(expect.arrayContaining(['server 0', 'gadget', 'overseer', 'presence', 'chat', 'workpieces'])))
  })

  it('connects the page at once, its calls pipelined on the gadget’s server side before that is reached', async () => {
    const { connection, gadget, frame, links } = setUp()
    connection.start()
    const pending = deferred<Awaited<ReturnType<GadgetHandle['connectToGadget']>>>()
    const server = pipelined(pending.promise)
    vi.mocked(gadget.connectToGadget).mockReturnValueOnce(server)
    handshake(frame)
    await vi.waitFor(() => expect(links()).toHaveLength(1))
    expect((links()[0]! as unknown as { gadget: unknown }).gadget).toBe(server)
    connection.stop()
  })

  it('says the gadget could not be connected to, when its server side could not be reached', async () => {
    const { connection, gadget, frame } = setUp()
    connection.start()
    await vi.waitFor(() => expect(connection.getSnapshot().ui.status).toBe('ready'))
    vi.mocked(gadget.connectToGadget).mockReturnValueOnce(pipelined(Promise.reject(new Error('gone'))))
    handshake(frame)
    await vi.waitFor(() => expect(connection.getSnapshot().ui).toEqual({ status: 'failed', message: 'Couldn’t connect to the gadget: gone' }))
    connection.stop()
  })

  it('passes on Escape, what the page logs and where the pointer is, through the root its page connects to', async () => {
    const { connection, frame, onEscape, onConsoleLog, onPointerAt, links } = setUp()
    connection.start()
    await vi.waitFor(() => expect(connection.getSnapshot().ui.status).toBe('ready'))
    handshake(frame)
    await vi.waitFor(() => expect(links()).toHaveLength(1))
    const root = links()[0]! as unknown as { escape(): void; reportConsole(level: unknown, message: unknown, at?: unknown): void; pointerAt(y: unknown): void; gadget: unknown }
    root.escape()
    expect(onEscape).toHaveBeenCalledOnce()
    root.pointerAt(42)
    root.pointerAt('42')
    root.pointerAt(Number.NaN)
    expect(onPointerAt.mock.calls).toEqual([[42]])
    root.reportConsole('error', ['Uncaught', 'boom'], { url: 'https://elsewhere.example/x.js', line: 3, column: 7 })
    root.reportConsole('shout', ['not a level'])
    expect(onConsoleLog).toHaveBeenCalledOnce()
    expect(onConsoleLog.mock.calls[0]![0]).toMatchObject({ level: 'error', message: ['Uncaught', 'boom', 'at https://elsewhere.example/x.js:3:7'] })
    expect(root.gadget).toBeDefined()
    connection.stop()
  })

  it('builds a page that starts a UI of modules with main(), and a legacy one with globals', async () => {
    const modules = setUp({ bundle: Promise.resolve<UiBundle | null>({ modules: [{ path: 'client.js', code: 'export default { main() {} }' }] }) })
    modules.connection.start()
    await vi.waitFor(() => expect(modules.connection.getSnapshot().ui.status).toBe('ready'))
    const page = (ui: GadgetUi) => (ui.status === 'ready' ? decodeURIComponent(ui.page) : '')
    expect(page(modules.connection.getSnapshot().ui)).toContain('<script type="importmap">')
    expect(page(modules.connection.getSnapshot().ui)).toContain('main.call(entry.default, gadget, host)')
    modules.connection.stop()

    const legacy = setUp()
    legacy.connection.start()
    await vi.waitFor(() => expect(legacy.connection.getSnapshot().ui.status).toBe('ready'))
    expect(page(legacy.connection.getSnapshot().ui)).toContain('globalThis.gadget = gadget')
    legacy.connection.stop()
  })

  it('loads the UI again, once, when the chat it is shown with changes its code, keeping the page shown meanwhile', async () => {
    const { connection, gadget, chats } = setUp()
    connection.start()
    await vi.waitFor(() => expect(connection.getSnapshot().ui.status).toBe('ready'))
    const author = person('agent')
    const statuses: string[] = []
    connection.subscribe(() => statuses.push(connection.getSnapshot().ui.status))

    chats().changeApplied(9, 0, 1, author, { 41: [] })
    chats().changeApplied(3, 0, 1, author, { 42: [] })
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(gadget.getUiBundle).toHaveBeenCalledTimes(1)

    chats().changeApplied(3, 0, 2, author, { 41: [] })
    chats().changeApplied(3, 0, 3, author, { 41: [], 42: [] })
    await vi.waitFor(() => expect(gadget.getUiBundle).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(statuses).toEqual(['ready']))
    const ui = connection.getSnapshot().ui
    expect(ui.status === 'ready' && ui.load).toBe(2)
    connection.stop()
  })

  it('loads the UI again when the chat’s changes start over, or the gadget’s head moves', async () => {
    const { connection, gadget, chats, workpieces } = setUp()
    connection.start()
    await vi.waitFor(() => expect(connection.getSnapshot().ui.status).toBe('ready'))

    chats().metadata(chat(1))
    chats().metadata(chat(1))
    workpieces().entry(head('a'))
    workpieces().entry(head('a', 'Renamed'))
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(gadget.getUiBundle).toHaveBeenCalledTimes(1)

    chats().metadata(chat(2))
    await vi.waitFor(() => expect(gadget.getUiBundle).toHaveBeenCalledTimes(2))
    workpieces().entry(head('b'))
    await vi.waitFor(() => expect(gadget.getUiBundle).toHaveBeenCalledTimes(3))
    connection.stop()
  })

  it('says which template the gadget follows, and how much of it it has, as the workspace says it', async () => {
    const { connection, gadget, workpieces } = setUp()
    connection.start()
    await vi.waitFor(() => expect(connection.getSnapshot().ui.status).toBe('ready'))
    workpieces().entry(head('a'))
    expect(connection.getSnapshot().upstream).toBeUndefined()
    workpieces().entry({ ...head('a'), upstream: { blueprintId: 'tip-jar', commitId: 'r1' } } as WorkpieceSummary)
    expect(connection.getSnapshot().upstream).toEqual({ blueprintId: 'tip-jar', commitId: 'r1' })
    // Taking an update moves its head and the release it has together.
    workpieces().entry({ ...head('b'), upstream: { blueprintId: 'tip-jar', commitId: 'r2' } } as WorkpieceSummary)
    expect(connection.getSnapshot()).toMatchObject({ commitId: 'b', upstream: { commitId: 'r2' } })
    await vi.waitFor(() => expect(gadget.getUiBundle).toHaveBeenCalledTimes(2))
    connection.stop()
  })

  it('connects again quietly: the page shown stays until the new one is loaded', async () => {
    const { connection, gadget, frame, disposed } = setUp()
    connection.start()
    await vi.waitFor(() => expect(connection.getSnapshot().ui.status).toBe('ready'))
    handshake(frame)
    await vi.waitFor(() => expect(gadget.connectToGadget).toHaveBeenCalledOnce())
    await Promise.resolve()
    const statuses: string[] = []
    connection.subscribe(() => statuses.push(connection.getSnapshot().ui.status))

    connection.reconnect()

    await vi.waitFor(() => expect(gadget.getUiBundle).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(statuses).toEqual(['ready']))
    expect(disposed).toEqual(expect.arrayContaining(['server 0', 'gadget', 'overseer', 'presence', 'chat', 'workpieces']))
    const ui = connection.getSnapshot().ui
    expect(ui.status === 'ready' && ui.load).toBe(2)
    connection.stop()
  })

  it.each(['overseer', 'gadget', 'server 0'])('loads again quietly when the %s breaks, keeping the page shown until the new one is there', async (stub) => {
    const { connection, gadget, frame, breaks } = setUp()
    connection.start()
    await vi.waitFor(() => expect(connection.getSnapshot().ui.status).toBe('ready'))
    handshake(frame)
    await vi.waitFor(() => expect(gadget.connectToGadget).toHaveBeenCalledOnce())
    await Promise.resolve()
    const statuses: string[] = []
    connection.subscribe(() => statuses.push(connection.getSnapshot().ui.status))

    breaks(stub)

    await vi.waitFor(() => expect(gadget.getUiBundle).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(statuses).toEqual(['ready']))
    connection.stop()
  })

  it('keeps trying, with growing waits, while the gadget cannot be reached', async () => {
    vi.useFakeTimers()
    const { connection, gadget, overseer, breaks } = setUp()
    connection.start()
    await vi.waitFor(() => expect(connection.getSnapshot().ui.status).toBe('ready'))
    vi.mocked(gadget.getUiBundle).mockReturnValue(new Promise(() => {}))

    breaks('overseer')
    expect(overseer.getGadget).toHaveBeenCalledTimes(2)
    breaks('overseer')
    expect(overseer.getGadget).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(overseer.getGadget).toHaveBeenCalledTimes(3)
    breaks('overseer')
    await vi.advanceTimersByTimeAsync(1000)
    expect(overseer.getGadget).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(overseer.getGadget).toHaveBeenCalledTimes(4)
    expect(connection.getSnapshot().ui.status).toBe('ready')
    connection.stop()
    vi.useRealTimers()
  })

  it('leaves a gadget that never loaded to say why', async () => {
    const pending = deferred<UiBundle | null>()
    const { connection, overseer, breaks } = setUp({ bundle: pending.promise })
    connection.start()
    breaks('overseer')
    pending.reject(new Error('The workspace restarted.'))
    await vi.waitFor(() => expect(connection.getSnapshot().ui).toEqual({ status: 'failed', message: 'The workspace restarted.' }))
    expect(overseer.getGadget).toHaveBeenCalledOnce()
    connection.stop()
  })

  it('lists who else is there once each, and not the viewer', async () => {
    const { connection, presence } = setUp()
    connection.start()
    await vi.waitFor(() => expect(presence()).toBeDefined())
    presence().init([
      { key: '1', user: person('me'), role: 'build' },
      { key: '2', user: person('grace'), role: 'build' },
      { key: '3', user: person('grace'), role: 'build' },
    ])
    expect(connection.getSnapshot().people).toEqual([person('grace')])
    presence().add({ key: '4', user: person('alan'), role: 'use' })
    presence().remove('2')
    expect(connection.getSnapshot().people).toEqual([person('grace'), person('alan')])
    presence().remove('3')
    expect(connection.getSnapshot().people).toEqual([person('alan')])
    connection.stop()
  })
})
