// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  ActionLogEntry, AiChatMessage, AiChatMetadata, AiChatSubscriber, Overseer,
} from '@gadgets/workshop-shared/api'

// Each observed element's callbacks, so a test can report a resize jsdom never lays out.
const resizeCallbacks = new Map<Element, Array<() => void>>()
vi.stubGlobal('ResizeObserver', class {
  constructor(private callback: () => void) {}
  observe(el: Element) { resizeCallbacks.set(el, [...(resizeCallbacks.get(el) ?? []), this.callback]) }
  disconnect() {}
})
// Reports `el` as `height` tall to whatever observes it.
function reportHeight(el: Element, height: number) {
  act(() => {
    Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
    for (const callback of resizeCallbacks.get(el) ?? []) callback()
  })
}
// jsdom lays nothing out; the message list scrolls itself to the bottom on every render.
Element.prototype.scrollTo = () => {}

const addToast = vi.hoisted(() => vi.fn<(options: unknown) => void>())

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  const Null = () => null
  const parts = new Proxy(Pass, {
    get: (_target, property) => property === 'Root' ? Null : Pass,
  })
  const toasts = { add: addToast }
  return {
    ...actual,
    Dialog: parts,
    DropdownMenu: parts,
    Popover: parts,
    Tooltip: Pass,
    useKumoToastManager: () => toasts,
  }
})

vi.mock('./AuthContext', () => {
  const context = {
    authenticatedApi: { listGatekeeperVendors: async () => [] },
    currentUser: null,
  }
  return {
    useAuthenticatedApi: () => context,
    useOptionalAuthenticatedApi: () => null,
  }
})

import {
  clickHookSwitch, deferred, entry, flushFrames, hookSwitch, makeOverseer, makeTestRoot,
} from './action-test-harness'
import ChatInterface from './ChatInterface'
import { INCOMPLETE_DESCRIPTION_COPY } from './components/IncompleteDescriptionNotice'
import { RESTRICTED_APPROVAL_COPY } from './components/RestrictedApprovalNotice'
import { linkActionLog } from './useActions'

const testRoot = makeTestRoot()

afterEach(() => {
  testRoot.cleanup()
  vi.restoreAllMocks()
})

function withChatApi(
  server: ReturnType<typeof makeOverseer>,
  getChatMessage = vi.fn<(chatId: number, sequence: number) => Promise<AiChatMessage | null>>(),
  chats: AiChatMetadata[] = [],
) {
  let subscriber: AiChatSubscriber | undefined
  Object.assign(server.overseer as object, {
    getChatMessage,
    getChatHistory: async () => ({ messages: [] }),
    listChats: async () => chats,
    listModels: async () => [],
    onRpcBroken: () => {},
    subscribeToChat: (next: AiChatSubscriber) => {
      subscriber = next
      return { [Symbol.dispose]: () => {} }
    },
    viewChat: () => ({ [Symbol.dispose]: () => {} }),
  })
  return {
    getChatMessage,
    emitMessage(message: AiChatMessage) {
      act(() => subscriber!.message(message))
    },
  }
}

type ChatProps = {
  restricted?: boolean, selectedChatId?: number,
  revealActionId?: number | null, onActionRevealed?: () => void,
  composerAccessory?: React.ReactNode,
}

function renderChat(overseer: RpcStub<Overseer>, props: ChatProps = {}) {
  return testRoot.render(chatElement(overseer, props))
}

// Holds the request to reveal and clears it once revealed, as the Workshop does. `reveal` asks
// for another.
let reveal: (actionId: number) => void
function RevealingChat({ overseer, initial }: { overseer: RpcStub<Overseer>, initial: number }) {
  const [revealActionId, setRevealActionId] = useState<number | null>(initial)
  reveal = setRevealActionId
  return chatElement(overseer, {
    selectedChatId: 1, revealActionId, onActionRevealed: () => setRevealActionId(null),
  })
}

function chatElement(overseer: RpcStub<Overseer>, props: ChatProps) {
  return (
    <ChatInterface
      workspaceId="workspace"
      overseer={overseer}
      restricted={props.restricted}
      selectedChatId={props.selectedChatId ?? null}
      revealActionId={props.revealActionId}
      onActionRevealed={props.onActionRevealed}
      composerAccessory={props.composerAccessory}
      onNavigateToChat={() => {}}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}}
      outputOfWorkpiece={() => undefined}
    />
  )
}

const actionMessage = {
  chatId: 1,
  sequence: 0,
  timestamp: new Date(),
  author: { type: 'agent', id: 'model', name: 'Model' },
  type: 'action',
  actionId: 1,
  actionLog: entry(1),
} as AiChatMessage

const resolvedMessage =
  { ...actionMessage, actionLog: entry(1, { state: 'approved' }) } as AiChatMessage

// Renders a first session that caches a pending action card, then settles it so a linked swap
// can resume. Pass a key to link the stub; unlinked sessions never park a watermark.
async function cachePendingCard(key?: string) {
  const first = makeOverseer()
  const firstChat = withChatApi(first)
  if (key !== undefined) linkActionLog(first.overseer, key)
  await renderChat(first.overseer)
  await first.resolveSubscription()
  await first.resolvePendingQuery({ entries: [entry(1)] })
  firstChat.emitMessage(actionMessage)
}

describe('ChatInterface action refresh', () => {
  it('refetches cached mutable cards when an unlinked stub swaps', async () => {
    await cachePendingCard()

    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(async () => resolvedMessage))
    await renderChat(second.overseer)
    await vi.waitFor(() => expect(secondChat.getChatMessage).toHaveBeenCalledWith(1, 0))
  })

  it('skips the cached-card refetch on a resumed linked stub swap', async () => {
    await cachePendingCard('ws-chat-resume')

    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(async () => resolvedMessage))
    linkActionLog(second.overseer, 'ws-chat-resume')
    await renderChat(second.overseer)
    await second.resolveSubscription()
    await second.resolvePendingQuery({ entries: [entry(1)] })
    expect(secondChat.getChatMessage).not.toHaveBeenCalled()
  })
})

// A pending action whose description runs to several paragraphs: what the approver has to read
// in full when the workspace is restricted.
const longDescription = [
  'Send the following email to alice@example.com:',
  'Hi Alice, attached are the quarterly numbers you asked for.',
  'Regards, the workspace.',
].join('\n\n')

function pendingLog(over: Partial<Record<string, unknown>> = {}) {
  return entry(1, {
    description: { title: 'Send email', description: longDescription, implementsRevert: false, ...over },
  })
}

// Renders chat 1 selected, so its messages -- and the action card for `log` -- are actually on
// screen.
async function renderPendingCard(log: ActionLogEntry, props: { restricted?: boolean } = {}) {
  const server = makeOverseer()
  const chat = withChatApi(server, undefined, [
    { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
  ])
  await renderChat(server.overseer, { ...props, selectedChatId: 1 })
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [log] })
  chat.emitMessage({ ...actionMessage, actionLog: log } as AiChatMessage)
  return server
}

const clampedDescription = () => document.querySelector('[class*="max-h-[200px]"]')

// Opens a pending card's details, which start collapsed to a one-line summary.
async function openDetails() {
  const toggle = document.querySelector('button[aria-expanded="false"]')
  if (!(toggle instanceof HTMLButtonElement)) throw new Error('No collapsed details to open')
  await act(async () => toggle.click())
}

// The text a screen reader announces as the Approve button's description.
function approveDescribedBy(): string | null {
  const approve = [...document.querySelectorAll('button')].find(b => b.textContent === 'Approve')
  if (!approve) throw new Error('No Approve button rendered')
  const ids = approve.getAttribute('aria-describedby')
  if (ids === null) return null
  return ids.split(' ').map(id => {
    const el = document.getElementById(id)
    if (!el) throw new Error(`aria-describedby names a missing element: ${id}`)
    return el.textContent ?? ''
  }).join('\n')
}

describe('restricted approval', () => {
  it('shows the notice and the full request on a pending card while restricted', async () => {
    await renderPendingCard(pendingLog(), { restricted: true })

    expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY)
    expect(document.body.textContent).toContain('Regards, the workspace.')
    expect(clampedDescription()).toBeNull()
    // The controls precede the review text in DOM order, so the buttons name it explicitly.
    const described = approveDescribedBy()
    expect(described).toContain(RESTRICTED_APPROVAL_COPY)
    expect(described).toContain('Regards, the workspace.')
    expect(described).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('names only the restricted notice and request for a complete description', async () => {
    await renderPendingCard(pendingLog({ descriptionIsComplete: true }), { restricted: true })

    const described = approveDescribedBy()
    expect(described).toContain(RESTRICTED_APPROVAL_COPY)
    expect(described).not.toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('shows the notice and the full request on a blocking card while restricted', async () => {
    await renderPendingCard(pendingLog({ awaitDecision: true }), { restricted: true })

    expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY)
    expect(clampedDescription()).toBeNull()
    const described = approveDescribedBy()
    expect(described).toContain(RESTRICTED_APPROVAL_COPY)
    expect(described).toContain('Regards, the workspace.')
  })

  it('names the fields as part of the request while restricted', async () => {
    const fields = [{ label: 'To', kind: 'list', items: ['a@example.com'] }]
    await renderPendingCard(pendingLog({ descriptionIsComplete: true, fields }), { restricted: true })

    expect(approveDescribedBy()).toContain('a@example.com')
  })

  for (const [name, over] of [['pending', {}], ['blocking', { awaitDecision: true }]] as const) {
    it(`shows a ${name} card's long fields without a scroll cap while restricted`, async () => {
      const fields = [{ label: 'Body', kind: 'text', value: 'Full body text' }]
      await renderPendingCard(pendingLog({ ...over, fields }), { restricted: true })

      const body = [...document.querySelectorAll('pre')].find(pre => pre.textContent === 'Full body text')
      expect(body?.className).not.toContain('max-h-56')
      expect(document.querySelector('[class*="max-h-[360px]"]')).toBeNull()
    })
  }

  it('collapses the request to its first line until opened when not restricted', async () => {
    await renderPendingCard(pendingLog())

    expect(document.body.textContent).toContain('Send the following email to alice@example.com:')
    expect(document.body.textContent).not.toContain('Regards, the workspace.')
    // Approving does not need the details open.
    expect([...document.querySelectorAll('button')].some(b => b.textContent === 'Approve')).toBe(true)

    await openDetails()
    expect(document.body.textContent).toContain('Regards, the workspace.')
  })

  it('keeps the scrolling description and no notice when not restricted', async () => {
    await renderPendingCard(pendingLog())
    await openDetails()

    expect(document.body.textContent).not.toContain(RESTRICTED_APPROVAL_COPY)
    expect(clampedDescription()).not.toBeNull()
    expect(approveDescribedBy()).toBeNull()
  })
})

describe('revealing a request', () => {
  // jsdom implements no scrolling.
  const scrollIntoView = vi.fn<(options?: ScrollIntoViewOptions) => void>()
  beforeEach(() => {
    scrollIntoView.mockClear()
    Element.prototype.scrollIntoView = scrollIntoView
  })
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView
  })

  it('scrolls to the card it names, then reports it revealed', async () => {
    const server = await renderPendingCard(pendingLog())
    const onActionRevealed = vi.fn<() => void>()
    await renderChat(server.overseer, { selectedChatId: 1, revealActionId: 1, onActionRevealed })

    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(scrollIntoView.mock.contexts[0]).toBe(document.querySelector('[data-action-id="1"]'))
    expect(onActionRevealed).toHaveBeenCalled()
  })

  it('waits for the chat history to load before looking for the card', async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
    ])
    let loadHistory!: (page: { messages: AiChatMessage[] }) => void
    Object.assign(server.overseer as object, {
      getChatHistory: () => new Promise(resolve => { loadHistory = resolve }),
    })
    const onActionRevealed = vi.fn<() => void>()
    await renderChat(server.overseer, { selectedChatId: 1, revealActionId: 1, onActionRevealed })
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [pendingLog()] })
    expect(onActionRevealed).not.toHaveBeenCalled()

    await act(async () => loadHistory({ messages: [{ ...actionMessage, actionLog: pendingLog() } as AiChatMessage] }))
    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(onActionRevealed).toHaveBeenCalled()
  })

  it('asks for an earlier page once and gives up when it fails', async () => {
    // Taller than its viewport, so the list's own fill-the-screen paging stays out of it.
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000)
    const server = makeOverseer()
    withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
    ])
    // The loaded page starts mid-thread, so there is earlier history to look through.
    const latest = { ...actionMessage, sequence: 5, actionLog: pendingLog() } as AiChatMessage
    const earlier = vi.fn<() => Promise<never>>(async () => { throw new Error('offline') })
    Object.assign(server.overseer as object, {
      getChatHistory: (_chatId: number, before?: number) =>
        before === undefined ? Promise.resolve({ messages: [latest] }) : earlier(),
    })
    const onActionRevealed = vi.fn<() => void>()
    addToast.mockClear()
    await renderChat(server.overseer, { selectedChatId: 1, revealActionId: 99, onActionRevealed })
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [pendingLog()] })
    for (let i = 0; i < 5; i++) await act(async () => {})

    expect(earlier).toHaveBeenCalledOnce()
    expect(addToast).toHaveBeenCalledOnce()
    expect(onActionRevealed).toHaveBeenCalledOnce()
    expect(scrollIntoView).not.toHaveBeenCalled()
  })

  it('lets a newer reveal finish when an older one\'s page fails', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000)
    const server = makeOverseer()
    withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
    ])
    const latest = { ...actionMessage, sequence: 5, actionLog: pendingLog() } as AiChatMessage
    let failEarlier!: (err: Error) => void
    Object.assign(server.overseer as object, {
      getChatHistory: (_chatId: number, before?: number) => before === undefined
        ? Promise.resolve({ messages: [latest] })
        : new Promise((_resolve, reject) => { failEarlier = reject }),
    })
    // Request 99 is not on screen, so its reveal asks for the page before.
    await testRoot.render(<RevealingChat overseer={server.overseer} initial={99} />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [pendingLog()] })
    expect(failEarlier).toBeDefined()

    // The approver moves on to request 1, which is on screen, before that page fails.
    act(() => reveal(1))
    await act(async () => failEarlier(new Error('offline')))
    for (let i = 0; i < 3; i++) await act(async () => {})

    expect(scrollIntoView).toHaveBeenCalledOnce()
    expect(scrollIntoView.mock.contexts[0]).toBe(document.querySelector('[data-action-id="1"]'))
  })

  it('leaves the next workspace\'s reveal alone when an earlier page fails after a switch', async () => {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000)
    const chats = [{ id: 1, title: 'Chat', started: new Date(), lastActive: new Date() }]
    // Workspace A: its page before request 5 fails, but only once B is on screen.
    const a = makeOverseer()
    withChatApi(a, undefined, chats)
    let failEarlier!: (err: Error) => void
    Object.assign(a.overseer as object, {
      getChatHistory: (_chatId: number, before?: number) => before === undefined
        ? Promise.resolve({ messages: [{ ...actionMessage, sequence: 5, actionLog: pendingLog() }] })
        : new Promise((_resolve, reject) => { failEarlier = reject }),
    })
    // Workspace B: its history arrives last, holding the request it reveals.
    const b = makeOverseer()
    withChatApi(b, undefined, chats)
    let loadB!: (page: { messages: AiChatMessage[] }) => void
    Object.assign(b.overseer as object, {
      getChatHistory: () => new Promise(resolve => { loadB = resolve }),
    })

    // As the Workshop does, the reveal outlives the chat, which is keyed by workspace.
    let switchToB!: () => void
    function Workspaces() {
      const [onB, setOnB] = useState(false)
      const [revealActionId, setRevealActionId] = useState<number | null>(99)
      switchToB = () => { setOnB(true); setRevealActionId(1) }
      return <div key={onB ? 'b' : 'a'}>{chatElement(onB ? b.overseer : a.overseer, {
        selectedChatId: 1, revealActionId, onActionRevealed: () => setRevealActionId(null),
      })}</div>
    }
    await testRoot.render(<Workspaces />)
    await a.resolveSubscription()
    await a.resolvePendingQuery({ entries: [pendingLog()] })
    expect(failEarlier).toBeDefined()

    act(() => switchToB())
    await b.resolveSubscription()
    await b.resolvePendingQuery({ entries: [pendingLog()] })
    await act(async () => failEarlier(new Error('offline')))
    await act(async () => loadB({ messages: [{ ...actionMessage, actionLog: pendingLog() } as AiChatMessage] }))
    for (let i = 0; i < 3; i++) await act(async () => {})

    expect(scrollIntoView).toHaveBeenCalledOnce()
  })

  it('gives up once the whole thread is loaded without the card', async () => {
    const server = await renderPendingCard(pendingLog())
    const onActionRevealed = vi.fn<() => void>()
    await renderChat(server.overseer, { selectedChatId: 1, revealActionId: 9, onActionRevealed })

    expect(scrollIntoView).not.toHaveBeenCalled()
    expect(onActionRevealed).toHaveBeenCalled()
  })
})

// Renders chat 1 with an accessory, with a resize() that reports it
// `height` tall.
async function renderWithAccessory() {
  const server = await renderPendingCard(pendingLog())
  await renderChat(server.overseer, { selectedChatId: 1, composerAccessory: <div id="accessory" /> })
  const floating = document.getElementById('accessory')!.parentElement!.parentElement!
  const list = document.querySelector('.chat-panel')!
  return { list, resize: (height: number) => reportHeight(floating, height) }
}

describe('composer accessory', () => {
  it('leaves room for the accessory and keeps a reader at the bottom there as it grows', async () => {
    const scrollTo = vi.spyOn(Element.prototype, 'scrollTo')
    const { list, resize } = await renderWithAccessory()
    scrollTo.mockClear()
    resize(300)
    expect((list.firstElementChild as HTMLElement).style.paddingBottom).toBe('344px')
    expect(scrollTo).toHaveBeenCalled()
  })

  it('leaves room for the accessory below the chat list too', async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
    ])
    await renderChat(server.overseer, { composerAccessory: <div id="accessory" /> })
    reportHeight(document.getElementById('accessory')!.parentElement!.parentElement!, 300)
    expect((document.querySelector('.chat-panel') as HTMLElement).style.paddingBottom).toBe('324px')
  })

  it('leaves a reader who scrolled up where they are', async () => {
    const scrollTo = vi.spyOn(Element.prototype, 'scrollTo')
    const { list, resize } = await renderWithAccessory()
    Object.defineProperties(list, {
      scrollHeight: { value: 2000, configurable: true },
      clientHeight: { value: 500, configurable: true },
      scrollTop: { value: 600, configurable: true, writable: true },
    })
    list.dispatchEvent(new Event('scroll'))
    scrollTo.mockClear()
    resize(300)
    expect(scrollTo).not.toHaveBeenCalled()
  })
})

describe('incomplete description notice', () => {
  it('flags a pending action whose description is not marked complete', async () => {
    await renderPendingCard(pendingLog())

    expect(document.body.textContent).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('flags a blocking action whose description is not marked complete', async () => {
    await renderPendingCard(pendingLog({ awaitDecision: true }))

    expect(document.body.textContent).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('shows no notice when the description is complete', async () => {
    await renderPendingCard(pendingLog({ descriptionIsComplete: true }))
    await openDetails()

    expect(document.body.textContent).toContain('Regards, the workspace.')
    expect(document.body.textContent).not.toContain(INCOMPLETE_DESCRIPTION_COPY)
  })
})

describe('action fields', () => {
  const body = 'LGTM ```but``` <script>alert(1)</script>'
  const fields = [{ label: 'Body', kind: 'text', value: body, syntax: 'markdown' }]

  for (const [name, over] of [['pending', {}], ['blocking', { awaitDecision: true }]] as const) {
    it(`shows a ${name} action's fields as literal text after the description`, async () => {
      await renderPendingCard(pendingLog({ ...over, fields }))
      await openDetails()

      const pre = [...document.body.querySelectorAll('pre')].find(el => el.textContent === body)
      expect(pre).toBeDefined()
      expect(document.body.querySelector('script')).toBeNull()
      expect(document.body.textContent).toContain('Send the following email to alice@example.com:')
    })
  }
})

// The server's refusal for a chat whose model an administrator disabled.
const disabledModel = 'The "Kimi K3" model is disabled on this deployment by an administrator.'

const openChat = { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() }

// Types into the composer on screen and submits it with Enter.
async function sendFromComposer(text: string) {
  const textarea = document.querySelector<HTMLTextAreaElement>('textarea[role="combobox"]')
  if (!textarea) throw new Error('No composer rendered')
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  return textarea
}

describe('send and retry failures', () => {
  beforeEach(() => {
    addToast.mockClear()
    // Each failure is logged as well as shown.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })

  it('says why a message could not be sent and keeps it in the composer', async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [openChat])
    Object.assign(server.overseer as object, {
      sendChatMessage: async () => { throw new Error(disabledModel) },
    })
    await renderChat(server.overseer, { selectedChatId: 1 })

    const textarea = await sendFromComposer('Summarize the report')

    expect(addToast).toHaveBeenCalledExactlyOnceWith(
        { title: 'Failed to send message', description: disabledModel, variant: 'error' })
    expect(textarea.value).toBe('Summarize the report')
  })

  it('says why a conversation could not be started', async () => {
    const server = makeOverseer()
    withChatApi(server)
    Object.assign(server.overseer as object, {
      newChat: async () => { throw new Error(disabledModel) },
    })
    await renderChat(server.overseer)

    const textarea = await sendFromComposer('Summarize the report')

    expect(addToast).toHaveBeenCalledExactlyOnceWith(
        { title: 'Failed to start conversation', description: disabledModel, variant: 'error' })
    expect(textarea.value).toBe('Summarize the report')
  })

  it('raises no toast for a send the connection dropped', async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [openChat])
    const sendChatMessage = vi.fn<() => Promise<void>>(async () => {
      throw new Error('Peer closed WebSocket: 1006 ')
    })
    Object.assign(server.overseer as object, { sendChatMessage })
    await renderChat(server.overseer, { selectedChatId: 1 })

    const textarea = await sendFromComposer('Summarize the report')

    expect(sendChatMessage).toHaveBeenCalledOnce()
    expect(addToast).not.toHaveBeenCalled()
    expect(textarea.value).toBe('Summarize the report')
  })

  // Renders chat 1 ending in an agent error, then presses its Retry.
  async function retryAfterError(retryAgent: () => Promise<void>) {
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [openChat])
    Object.assign(server.overseer as object, { retryAgent })
    await renderChat(server.overseer, { selectedChatId: 1 })
    chat.emitMessage({
      chatId: 1,
      sequence: 0,
      timestamp: new Date(),
      author: { type: 'agent', id: 'model', name: 'Model' },
      type: 'error',
      message: 'The model request failed.',
    })
    const retry = [...document.querySelectorAll('button')].find(b => b.textContent === 'Retry')
    if (!retry) throw new Error('No Retry button rendered')
    await act(async () => retry.click())
  }

  it('says why a retry failed', async () => {
    await retryAfterError(async () => { throw new Error(disabledModel) })

    expect(addToast).toHaveBeenCalledExactlyOnceWith(
        { title: 'Failed to retry agent', description: disabledModel, variant: 'error' })
  })

  it('reports a retry the connection dropped without the transport message', async () => {
    await retryAfterError(async () => { throw new Error('Peer closed WebSocket: 1006 ') })

    expect(addToast).toHaveBeenCalledExactlyOnceWith(
        { title: 'Failed to retry agent', description: undefined, variant: 'error' })
  })

  it('shows a turn the user stopped as stopped, not as an error, and offers Continue', async () => {
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [openChat])
    await renderChat(server.overseer, { selectedChatId: 1 })
    chat.emitMessage({
      chatId: 1,
      sequence: 0,
      timestamp: new Date(),
      author: { type: 'agent', id: 'model', name: 'Model' },
      type: 'error',
      message: 'The user stopped the agent.',
      code: 'stopped',
    })

    const text = document.body.textContent ?? ''
    expect(text).toContain('Stopped')
    expect(text).not.toContain('Error:')
    expect(text).not.toContain('The user stopped the agent.')
    const buttons = [...document.querySelectorAll('button')].map(b => b.textContent)
    expect(buttons).toContain('Continue')
    expect(buttons).not.toContain('Retry')
  })
})

describe('hook toggles', () => {
  const TITLE = 'Watch acme/widgets on GitHub'
  const refusal = "GitHub refused to add a webhook to acme/widgets: only the repository's admins can."
  const bound = (enabled: boolean) => entry(1, {
    type: 'bindHook', state: 'approved', hookId: 7, enabled,
    description: { title: TITLE, description: 'Call this hook with each issue event.' },
  })

  beforeEach(() => {
    addToast.mockClear()
    // Each failure is logged as well as shown.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  /** The open chat showing the card of a hook bound in it, whose enable/disable calls the test answers. */
  async function renderHookCard(enabled = false) {
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [openChat])
    const enableHook = vi.fn<(id: number) => Promise<void>>(async () => {})
    const disableHook = vi.fn<(id: number) => Promise<void>>(async () => {})
    Object.assign(server.overseer as object, { enableHook, disableHook })
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    chat.emitMessage({ ...actionMessage, actionLog: bound(enabled) } as AiChatMessage)
    return { server, enableHook, disableHook }
  }

  const isOn = () => hookSwitch(TITLE).getAttribute('aria-checked') === 'true'

  /** The server's update of the hook's record, which the card follows. */
  async function recorded(server: ReturnType<typeof makeOverseer>, enabled: boolean) {
    await server.emit(bound(enabled))
    flushFrames()
  }

  it('turns a hook bound in the chat on and off', async () => {
    const { server, enableHook, disableHook } = await renderHookCard()
    expect(hookSwitch(TITLE).getAttribute('role')).toBe('switch')

    await clickHookSwitch(TITLE)
    expect(enableHook).toHaveBeenCalledExactlyOnceWith(7)
    await recorded(server, true)
    expect(isOn()).toBe(true)

    await clickHookSwitch(TITLE)
    expect(disableHook).toHaveBeenCalledExactlyOnceWith(7)
    await recorded(server, false)
    expect(isOn()).toBe(false)
    expect(addToast).not.toHaveBeenCalled()
  })

  it.each([
    ['enabled', false, 'enableHook', new Error(refusal), refusal],
    ['enabled', false, 'enableHook', new Error('Peer closed WebSocket: 1006 '), undefined],
    ['disabled', true, 'disableHook', new Error(refusal), refusal],
    ['disabled', true, 'disableHook', new Error('Peer closed WebSocket: 1006 '), undefined],
  ] as const)(
    'says why a hook could not be %s, though not a dropped connection’s transport message, and turns it back',
    async (done, enabled, method, failure, description) => {
      const calls = await renderHookCard(enabled)
      calls[method].mockRejectedValueOnce(failure)

      await clickHookSwitch(TITLE)

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: `Failed to ${done === 'enabled' ? 'enable' : 'disable'} hook`, description, variant: 'error',
      })
      expect(isOn()).toBe(enabled)
    })

  it('shows a change at once, holds the switch busy while it is in flight, and lets a failed one be retried', async () => {
    const { server, enableHook, disableHook } = await renderHookCard()
    const first = deferred()
    enableHook.mockReturnValueOnce(first.promise)

    await clickHookSwitch(TITLE)
    expect(isOn()).toBe(true)
    expect(hookSwitch(TITLE).getAttribute('aria-disabled')).toBe('true')
    expect(hookSwitch(TITLE).getAttribute('aria-busy')).toBe('true')
    await clickHookSwitch(TITLE)
    expect(enableHook).toHaveBeenCalledOnce()
    expect(disableHook).not.toHaveBeenCalled()

    await first.reject(new Error(refusal))
    expect(isOn()).toBe(false)
    expect(hookSwitch(TITLE).hasAttribute('aria-disabled')).toBe(false)
    expect(hookSwitch(TITLE).hasAttribute('aria-busy')).toBe(false)

    await clickHookSwitch(TITLE)
    expect(enableHook).toHaveBeenCalledTimes(2)
    await recorded(server, true)
    expect(isOn()).toBe(true)
  })
})

describe('queued steers', () => {
  it('shows every queued steer and hands them all to the draft on Stop', async () => {
    const server = makeOverseer()
    const agent = { type: 'agent', id: 'model', name: 'Model' } as const
    withChatApi(server, undefined, [{
      ...openChat,
      activeAgent: agent,
      queuedSteers: [
        { text: 'Make it dark.', author: { type: 'user', id: 'me', name: 'Me' } },
        { text: 'And bigger.', author: { type: 'user', id: 'collaborator', name: 'Collaborator' } },
      ],
    }])
    const stopAgent = vi.fn<(chatId: number) => Promise<void>>(async () => {})
    Object.assign(server.overseer as object, { stopAgent })
    await renderChat(server.overseer, { selectedChatId: 1 })

    const text = document.body.textContent ?? ''
    expect(text.indexOf('Make it dark.')).toBeGreaterThan(-1)
    expect(text.indexOf('And bigger.')).toBeGreaterThan(text.indexOf('Make it dark.'))
    expect(text).toContain('Collaborator')

    const stop = document.querySelector<HTMLButtonElement>('[aria-label="Stop agent"]')
    if (!stop) throw new Error('No Stop button rendered')
    await act(async () => stop.click())

    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[role="combobox"]')
    expect(textarea?.value).toBe('Make it dark.\n\nAnd bigger.')
    expect(stopAgent).toHaveBeenCalledExactlyOnceWith(1)
  })
})
