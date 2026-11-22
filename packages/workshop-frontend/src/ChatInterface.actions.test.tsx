// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  ActionLogEntry, AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiChatSubscriber, Overseer,
} from '@gadgets/workshop-shared/api'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
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
vi.mock('./ThemeContext', async (importOriginal) => ({
  ...await importOriginal() as typeof import('./ThemeContext'),
  useTheme: () => ({ resolvedThemeMode: 'light' }),
}))

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
    // Read by the pending-changes tray, which gates its auto-approval labels on real rules.
    listPreApprovableActions: async () => [],
    listAutoApprovedActionKinds: async () => [],
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
    emitStream(chatId: number, event: AiChatStreamEvent) {
      act(() => subscriber!.stream(chatId, event))
      flushFrames()
    },
  }
}

function renderChat(
  overseer: RpcStub<Overseer>,
  props: { restricted?: boolean, selectedChatId?: number } = {},
) {
  return testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={overseer}
      restricted={props.restricted}
      selectedChatId={props.selectedChatId ?? null}
      onNavigateToChat={() => {}}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}}
      outputOfWorkpiece={() => undefined}
    />,
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
    description: {
      title: 'Send email', description: longDescription, implementsRevert: false,
      autoApprovable: false, ...over,
    },
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
}

const clampedDescription = () => document.querySelector('[class*="max-h-[200px]"]')

/**
 * Opens a disclosure by the text on its button.
 *
 * A non-blocking request is decided in the tray above the composer rather than in the
 * transcript, so its review text sits behind the resource group's disclosure, and (unless the
 * workspace is restricted) its fields behind the request's own.
 */
async function openDisclosure(text: string): Promise<void> {
  const button = [...document.querySelectorAll('button[aria-expanded]')]
    .find(candidate => (candidate.textContent ?? '').includes(text))
  if (!button) throw new Error(`No disclosure labelled "${text}"`)
  await act(async () => (button as HTMLButtonElement).click())
}

/** Opens the tray group holding the chat's single pending request. */
const openTray = () => openDisclosure('1 request')

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

describe('pending queue failure', () => {
  it('keeps the decision in the transcript when the tray never loaded its queue', async () => {
    // The store holds an empty pending set for the life of the connection after a failed load,
    // so the tray has nothing to show. Leaving the request as "Waiting for review" would leave
    // no way to answer it at all.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
    ])
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    await server.rejectPendingQuery(new Error('The queue could not be read.'))
    chat.emitMessage({ ...actionMessage, actionLog: pendingLog() } as AiChatMessage)

    const labels = [...document.querySelectorAll('button')].map(b => b.textContent)
    expect(labels).toContain('Approve')
    expect(labels).toContain('Deny')
    expect(document.body.textContent).not.toContain('Waiting for review')
  })

  it('keeps the decision in the transcript while the queue is still loading', async () => {
    // The queue pages in, so until it settles the tray may not have this request yet. A card
    // that said "Waiting for review" meanwhile would be pointing at a surface that cannot
    // show it.
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
    ])
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    chat.emitMessage({ ...actionMessage, actionLog: pendingLog() } as AiChatMessage)

    expect([...document.querySelectorAll('button')].map(b => b.textContent)).toContain('Approve')

    // And hands it over once the queue has settled and the tray can show it.
    await server.resolvePendingQuery({ entries: [pendingLog()] })
    expect([...document.querySelectorAll('button')].map(b => b.textContent))
      .not.toContain('Approve')
  })

  it('keeps the decision in the transcript when the loaded queue omits this request', async () => {
    // A settled queue is not the same as a queue holding this request: `pendingChangeGroups`
    // drops anything with no gatekeeperId, and the subscription can land after the message that
    // announced the request. Deferring on "the queue loaded" alone left the card saying
    // "Waiting for review" while the tray showed nothing for it -- no surface offering it.
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
    ])
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [] })
    chat.emitMessage({ ...actionMessage, actionLog: pendingLog() } as AiChatMessage)

    const labels = [...document.querySelectorAll('button')].map(b => b.textContent)
    expect(labels).toContain('Approve')
    expect(document.body.textContent).not.toContain('Waiting for review')
    // And it is answerable without first expanding it: a card carrying Approve in its header
    // while showing none of what it would approve is the one shape this must not take.
    // Markdown reflows the paragraphs, so this checks the last of them is on screen.
    expect(document.body.textContent).toContain('Regards, the workspace.')
  })

  it('locks the blocking callout while a bulk run is sending its own decisions', async () => {
    // `pendingChangeGroups` does not filter out awaitDecision, so a blocking request is in the
    // tray's queue as well as in this callout. The run owns the view it is shown in, and the
    // tray locks its rows for the length of a run; this callout sits in the same view, so a
    // click here would race the run just as a click on its row would.
    const blocking = pendingLog({ awaitDecision: true })
    // The tray only offers a bulk run over more than one request, and a sibling on the same
    // connection is what a run would be working through when the callout is clicked.
    const sibling = entry(2, {
      description: {
        title: 'Send another email', description: 'Second', implementsRevert: false,
        autoApprovable: false,
      },
    })
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
    ])
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [blocking, sibling] })
    chat.emitMessage({ ...actionMessage, actionLog: blocking } as AiChatMessage)

    const approve = () =>
      [...document.querySelectorAll('button')].find(b => b.textContent === 'Approve')!
    expect(approve().disabled).toBe(false)

    const applyAll = [...document.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').startsWith('Apply all'))!
    await act(async () => { applyAll.click() })

    // The run has sent its first decision and is awaiting the provider. The callout must not
    // decide anything out of the run's order meanwhile.
    expect(server.decisionCalls).toEqual(['approve:1'])
    expect(approve().disabled).toBe(true)
  })

  it('keeps the workspace queue on screen after going back to the conversation list', async () => {
    // The queue is the workspace's, not the open conversation's. A request from a hook or a
    // scheduled task belongs to no conversation at all, so if the tray went away with the
    // transcript, this screen would reach it only through Activity -- and going Back would hide
    // an outstanding queue entirely.
    const server = makeOverseer()
    withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
    ])
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [pendingLog()] })

    expect(document.body.textContent).toContain('1 request')

    // Back to the conversation list, with the request still pending.
    await renderChat(server.overseer, {})
    expect(document.body.textContent).toContain('1 request')
  })

  it('keeps bulk apply when the vendor catalog fails, since a run reads only the rules', async () => {
    // The catalog starts every gatekeeper a gadget binds and fails whole if any one of them does.
    // All it gives the tray is logos, so losing it must not take Apply all away with it.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = makeOverseer()
    withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
    ])
    Object.assign(server.overseer as object, {
      listPreApprovableActions: async () => { throw new Error('One connection is unreachable.') },
    })
    const sibling = entry(2, {
      description: {
        title: 'Send another email', description: 'Second', implementsRevert: false,
        autoApprovable: false,
      },
    })
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [pendingLog(), sibling] })
    await act(async () => {})

    const labels = [...document.querySelectorAll('button')].map(b => b.textContent ?? '')
    expect(labels.some(label => label.startsWith('Apply all'))).toBe(true)
  })

  it("keeps a stopped run's message on screen after the queue empties", async () => {
    // The request a run stops at is often the last one left, and it can land a moment later --
    // a discard whose last request was applied first. The message saying so must not leave
    // with the queue.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = makeOverseer()
    withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
    ])
    const first = pendingLog()
    const second = entry(2, {
      description: {
        title: 'Send another email', description: 'Second', implementsRevert: false,
        autoApprovable: false,
      },
    })
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [first, second] })

    const applyAll = [...document.querySelectorAll('button')]
      .find(b => (b.textContent ?? '').startsWith('Apply all'))!
    await act(async () => { applyAll.click() })
    await server.failDecision(new Error('The provider failed.'))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 400)) })
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('"Send email" failed: The provider failed.')

    // Both are then resolved elsewhere, which empties the queue.
    await server.emit({ ...first, state: 'approved' } as typeof first)
    await server.emit({ ...second, state: 'rejected' } as typeof second)
    flushFrames()
    expect(document.body.textContent).not.toContain('requests waiting')
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('"Send email" failed: The provider failed.')
  })

  it('leaves the decision to the tray once the queue has loaded', async () => {
    await renderPendingCard(pendingLog())

    const labels = [...document.querySelectorAll('button')].map(b => b.textContent)
    expect(labels).not.toContain('Approve')
    expect(document.body.textContent).toContain('Waiting for review')
  })
})

describe('restricted approval', () => {
  it('shows the notice and the full request in the tray while restricted', async () => {
    await renderPendingCard(pendingLog(), { restricted: true })
    await openTray()

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
    await openTray()

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
    await openTray()

    expect(approveDescribedBy()).toContain('a@example.com')
  })

  for (const [name, over] of [['pending', {}], ['blocking', { awaitDecision: true }]] as const) {
    it(`shows a ${name} request's long fields without a scroll cap while restricted`, async () => {
      const fields = [{ label: 'Body', kind: 'text', value: 'Full body text' }]
      await renderPendingCard(pendingLog({ ...over, fields }), { restricted: true })
      if (name === 'pending') await openTray()

      const body = [...document.querySelectorAll('pre')].find(pre => pre.textContent === 'Full body text')
      expect(body?.className).not.toContain('max-h-56')
      expect(document.querySelector('[class*="max-h-[360px]"]')).toBeNull()
    })
  }

  it('keeps the blocking card scrolling, with no notice, when not restricted', async () => {
    await renderPendingCard(pendingLog({ awaitDecision: true }))

    expect(document.body.textContent).not.toContain(RESTRICTED_APPROVAL_COPY)
    expect(clampedDescription()).not.toBeNull()
    expect(approveDescribedBy()).toBeNull()
  })

  it('summarises a tray request, and names nothing, when not restricted', async () => {
    await renderPendingCard(pendingLog())
    await openTray()

    expect(document.body.textContent).not.toContain(RESTRICTED_APPROVAL_COPY)
    // Clamped rather than scrolled: the tray shows a preview and opens the request for the rest.
    expect(document.querySelector('[class*="line-clamp-2"]')).not.toBeNull()
    expect(approveDescribedBy()).toBeNull()
  })
})

describe('incomplete description notice', () => {
  it('flags a pending action whose description is not marked complete', async () => {
    await renderPendingCard(pendingLog())
    await openTray()

    expect(document.body.textContent).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('flags a blocking action whose description is not marked complete', async () => {
    await renderPendingCard(pendingLog({ awaitDecision: true }))

    expect(document.body.textContent).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('shows no notice when the description is complete', async () => {
    await renderPendingCard(pendingLog({ descriptionIsComplete: true }))
    await openTray()
    await openDisclosure('Send email')

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
      if (name === 'pending') {
        await openTray()
        await openDisclosure('Send email')
      }

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

describe('live views', () => {
  const agent = { type: 'agent', id: 'model', name: 'Model' } as const
  const view = '<inline-html>\n<title>Spending</title>\n<p>Food: $120</p>\n</inline-html>'
  const answer = `Here it is.\n\n${view}\n\nAsk me for more.`

  beforeEach(() => {
    // Every view is near the viewport.
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private callback: IntersectionObserverCallback) {}
      observe() { this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as never) }
      disconnect() {}
    })
  })

  // Streams `answer` in two parts, the first ending inside the block, then stores `stored`.
  async function streamThenStore(stored: string) {
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [{ ...openChat, activeAgent: agent }])
    await renderChat(server.overseer, { selectedChatId: 1 })
    const cut = answer.indexOf('<p>')

    chat.emitStream(1, { type: 'textDelta', delta: answer.slice(0, cut) })
    const streamed = document.querySelector('iframe[title="Spending"]')
    expect(streamed).not.toBeNull()

    chat.emitStream(1, { type: 'textDelta', delta: answer.slice(cut) })
    expect(document.querySelector('iframe[title="Spending"]')).toBe(streamed)

    chat.emitMessage({ type: 'message', chatId: 1, sequence: 0, timestamp: new Date(), author: agent, message: stored })
    flushFrames()
    expect(document.querySelectorAll('iframe')).toHaveLength(1)
    return { streamed, stored: document.querySelector('iframe[title="Spending"]') }
  }

  it('draws a view as its block streams, and keeps the same frame as it closes and is stored', async () => {
    const { streamed, stored } = await streamThenStore(answer)
    expect(stored).toBe(streamed)
  })

  it('starts the view again when the stored answer is not the text this client saw stream', async () => {
    // As for a client that lost deltas while it reconnected.
    const { streamed, stored } = await streamThenStore(`Earlier text. ${answer}`)
    expect(stored).not.toBeNull()
    expect(stored).not.toBe(streamed)
  })
})

// A scheduled task is created mid-turn, but its card carries the enable toggle, so it has to land
// at the end of the turn where the user will see it.
describe('scheduled task card placement', () => {
  const base = { chatId: 1, timestamp: new Date() }
  const agent = { type: 'agent', id: 'model', name: 'Model' } as const
  const hookLog = {
    id: 1,
    resourceTitle: 'Scheduled Tasks',
    createdAt: new Date(),
    state: 'approved',
    type: 'bindHook',
    description: { title: 'Motivational quote', description: 'Post a quote.' },
    hookId: 7,
    enabled: false,
  } as ActionLogEntry

  const user = (sequence: number, message: string) =>
    ({ ...base, sequence, author: { type: 'user', id: 'u', name: 'User' }, type: 'message', message })
  const hook = { ...base, sequence: 3, author: agent, type: 'action', actionId: 1, actionLog: hookLog }
  const turn = [
    user(1, 'schedule a quote'),
    { ...base, sequence: 2, author: agent, type: 'message', message: '', toolCalls: [{
      toolCallId: 'tc-2', toolName: 'readFile', input: { filename: 'server.js' } }] },
    hook,
    { ...base, sequence: 4, author: agent, type: 'useGadget' },
    { ...base, sequence: 5, author: agent, type: 'message', message: 'Created your task.' },
  ] as AiChatMessage[]

  async function renderTurn(messages = turn) {
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
    ])
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [] })
    for (const message of messages) chat.emitMessage(message)
  }

  const position = (el: Element | null | undefined) => {
    if (!el) throw new Error('Expected element is missing')
    return [...document.querySelectorAll('*')].indexOf(el)
  }
  const textElement = (text: string) =>
    [...document.querySelectorAll('*')].toReversed().find(el => el.textContent?.includes(text))
  const hasHookCard = () => document.body.textContent?.includes('Hook: Motivational quote')

  it('renders the card exactly once', async () => {
    await renderTurn()

    expect(document.body.textContent?.split('Hook: Motivational quote').length).toBe(2)
  })

  it('places the card after the closing text and the copy button, not mid-turn', async () => {
    await renderTurn()

    expect(hasHookCard()).toBe(true)
    const card = textElement('Hook: Motivational quote')
    const copy = document.querySelector('button[aria-label="Copy message"]')
    expect(position(card)).toBeGreaterThan(position(textElement('Created your task.')))
    expect(position(card)).toBeGreaterThan(position(copy))
    expect(position(card)).toBeGreaterThan(position(textElement('Used the gadget')))
  })

  it('keeps the card with its own turn once the conversation moves on', async () => {
    await renderTurn([
      ...turn,
      user(6, 'thanks'),
      { ...base, sequence: 7, author: agent, type: 'message', message: 'You are welcome.' },
    ] as AiChatMessage[])

    const card = textElement('Hook: Motivational quote')
    expect(position(card)).toBeGreaterThan(position(textElement('Created your task.')))
    expect(position(card)).toBeLessThan(position(textElement('thanks')))
  })

  it('still shows a card that has no agent message to attach to', async () => {
    await renderTurn([user(1, 'schedule a quote'), { ...hook, sequence: 2 }] as AiChatMessage[])

    expect(hasHookCard()).toBe(true)
  })
})
