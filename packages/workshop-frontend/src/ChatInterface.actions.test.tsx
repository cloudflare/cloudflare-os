// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  ActionLogEntry, AiChatMessage, AiChatMetadata, AiChatSubscriber, Overseer,
} from '@gadgets/workshop-shared/api'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
// jsdom lays nothing out; the message list scrolls itself to the bottom on every render.
Element.prototype.scrollTo = () => {}

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  const Null = () => null
  const parts = new Proxy(Pass, {
    get: (_target, property) => property === 'Root' ? Null : Pass,
  })
  const toasts = { add: vi.fn<(options: unknown) => void>() }
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

import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
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
  })
  return {
    getChatMessage,
    emitMessage(message: AiChatMessage) {
      act(() => subscriber!.message(message))
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

// Renders a first session that caches a pending action card, then settles it so a linked swap
// can resume. Pass a key to link the stub; unlinked sessions never park a watermark.
async function cachePendingCard(key?: string) {
  const first = makeOverseer()
  const firstChat = withChatApi(first)
  if (key !== undefined) linkActionLog(first.overseer, key)
  await renderChat(first.overseer, { selectedChatId: 1 })
  await first.resolveSubscription()
  await first.resolvePendingQuery({ entries: [entry(1), entry(2)] })
  firstChat.emitMessage(actionMessage)
  flushFrames()
}

// Renders one resolved action card in a live chat, which is where its status label is derived.
async function renderResolvedCard(over: Record<string, unknown>) {
  const resolved = entry(1, over)
  const server = makeOverseer()
  const chat = withChatApi(server)
  await renderChat(server.overseer, { selectedChatId: 1 })
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [resolved] })
  chat.emitMessage({ ...actionMessage, actionLog: resolved } as AiChatMessage)
  flushFrames()
}

describe('ChatInterface action refresh', () => {
  it('shows a missed failure on a cached card after a stub swap', async () => {
    await cachePendingCard()

    const failed = entry(1, { failure: 'page was deleted while disconnected' })
    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(async () =>
      ({ ...actionMessage, actionLog: failed }) as AiChatMessage))
    await renderChat(second.overseer, { selectedChatId: 1 })
    await second.resolveSubscription()
    await second.resolvePendingQuery({ entries: [failed, entry(2)] })
    await vi.waitFor(() => expect(secondChat.getChatMessage).toHaveBeenCalledWith(1, 0))
    flushFrames()

    expect(document.body.textContent).toContain('page was deleted while disconnected')
  })

  it('lets a resumed reconnect replay the gap instead of refetching', async () => {
    await cachePendingCard('ws-chat-resume')

    const failed = entry(1, {
      failure: 'page was deleted while disconnected',
      appliedAt: new Date(1700005000000),
    })
    const second = makeOverseer()
    const secondChat = withChatApi(second)
    linkActionLog(second.overseer, 'ws-chat-resume')
    await renderChat(second.overseer, { selectedChatId: 1 })
    await second.resolveSubscription()
    await second.resolvePendingQuery({ entries: [failed, entry(2)] })
    await second.emit(failed)
    flushFrames()

    expect(secondChat.getChatMessage).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('page was deleted while disconnected')
  })

  it('does not let a stale refresh regress a card resolved by the new subscription', async () => {
    await cachePendingCard()

    let resolveFetch!: (message: AiChatMessage | null) => void
    const fetched = new Promise<AiChatMessage | null>(resolve => { resolveFetch = resolve })
    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(() => fetched))
    await renderChat(second.overseer, { selectedChatId: 1 })
    await vi.waitFor(() => expect(secondChat.getChatMessage).toHaveBeenCalledWith(1, 0))
    await second.resolveSubscription()
    await second.resolvePendingQuery({ entries: [entry(1), entry(2)] })
    await second.emit(entry(1, { state: 'approved' }))
    flushFrames()

    await act(async () => resolveFetch({
      ...actionMessage,
      actionLog: entry(1, { failure: 'stale failure' }),
    } as AiChatMessage))
    flushFrames()

    expect(document.body.textContent).toContain('Approved')
    expect(document.body.textContent).not.toContain('stale failure')
  })
})

describe('ChatInterface action failure note', () => {
  it("shows the gatekeeper's reason on a pending action card", async () => {
    const failed = entry(1, { failure: 'page was deleted upstream' })
    const server = makeOverseer()
    const chat = withChatApi(server)
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [failed] })
    chat.emitMessage({ ...actionMessage, actionLog: failed } as AiChatMessage)

    expect(document.body.textContent).toContain('page was deleted upstream')
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
}

const clampedDescription = () => document.querySelector('[class*="max-h-[200px]"]')

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

  it('keeps the scrolling description and no notice when not restricted', async () => {
    await renderPendingCard(pendingLog())

    expect(document.body.textContent).not.toContain(RESTRICTED_APPROVAL_COPY)
    expect(clampedDescription()).not.toBeNull()
    expect(approveDescribedBy()).toBeNull()
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

      const pre = [...document.body.querySelectorAll('pre')].find(el => el.textContent === body)
      expect(pre).toBeDefined()
      expect(document.body.querySelector('script')).toBeNull()
      expect(document.body.textContent).toContain('Send the following email to alice@example.com:')
    })
  }
})

describe('ChatInterface action status', () => {
  it('presents a cascade invalidation as invalidated rather than denied', async () => {
    await renderResolvedCard({ state: 'rejected', cascadedFrom: 2 })

    expect(document.body.textContent).toContain('Invalidated')
    expect(document.body.textContent).not.toContain('Denied')
  })

  it('presents a direct rejection as denied', async () => {
    await renderResolvedCard({ state: 'rejected' })

    expect(document.body.textContent).toContain('Denied')
    expect(document.body.textContent).not.toContain('Invalidated')
  })
})
