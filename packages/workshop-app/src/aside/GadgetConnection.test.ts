import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiChatAuthorInfo, AiChatMetadata, AiChatSubscriber, PresenceSubscriber, UiBundle, WorkpieceSummary, WorkpiecesSubscriber } from '@gadgets/workshop-shared/api'
import { GadgetConnection, type GadgetHandle, type GadgetOverseer } from './GadgetConnection'

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
})

const setUp = ({ bundle = Promise.resolve<UiBundle | null>({ jsCode: 'render()' }) } = {}) => {
  const disposed: string[] = []
  const servers: { [Symbol.dispose]: () => void }[] = []
  const lease = (name: string) => ({ [Symbol.dispose]: () => disposed.push(name) })
  let presence: PresenceSubscriber | undefined
  let chats: AiChatSubscriber | undefined
  let workpieces: WorkpiecesSubscriber | undefined
  const gadget: GadgetHandle = {
    getUiBundle: vi.fn<GadgetHandle['getUiBundle']>(() => bundle),
    connectToGadget: vi.fn<GadgetHandle['connectToGadget']>(async () => {
      const server = lease(`server ${servers.length}`)
      servers.push(server)
      return server
    }),
    ...lease('gadget'),
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
    ...lease('overseer'),
  }
  const onEscape = vi.fn<() => void>()
  const connection = new GadgetConnection(() => overseer, 41, { chatId: 3, viewerId: 'me', onEscape })
  const frame = {} as Window
  connection.showIn(() => frame)
  return { connection, overseer, gadget, frame, disposed, onEscape, presence: () => presence!, chats: () => chats!, workpieces: () => workpieces! }
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
    expect(ui.status === 'ready' && ui.page).toContain(encodeURIComponent('render()'))
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
    const pending = deferred<Disposable>()
    vi.mocked(gadget.connectToGadget).mockReturnValueOnce(pending.promise)
    handshake(frame)
    connection.reload()
    pending.resolve({ [Symbol.dispose]: () => disposed.push('overtaken') })
    await vi.waitFor(() => expect(disposed).toContain('overtaken'))

    handshake(frame)
    await vi.waitFor(() => expect(gadget.connectToGadget).toHaveBeenCalledTimes(2))
    await Promise.resolve()
    connection.stop()
    await vi.waitFor(() => expect(disposed).toEqual(expect.arrayContaining(['server 0', 'gadget', 'overseer', 'presence', 'chat', 'workpieces'])))
  })

  it('passes on Escape from its own page only', () => {
    const { connection, frame, onEscape } = setUp()
    connection.start()
    received!({ source: {} as Window, origin: 'null', data: { type: 'escape' } })
    expect(onEscape).not.toHaveBeenCalled()
    received!({ source: frame, origin: 'null', data: { type: 'escape' } })
    expect(onEscape).toHaveBeenCalledOnce()
    connection.stop()
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
