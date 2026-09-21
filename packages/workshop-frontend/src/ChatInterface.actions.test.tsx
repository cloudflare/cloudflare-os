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

const onReviewActions = vi.fn<(gatekeeperId?: number) => void>()

function renderChat(overseer: RpcStub<Overseer>, props: { selectedChatId?: number } = {}) {
  return testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={overseer}
      selectedChatId={props.selectedChatId ?? null}
      onNavigateToChat={() => {}}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      onReviewActions={onReviewActions}
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

// Renders action 1's card in a live chat, which is where its status label and notes are derived.
// `entries` is the pending page the session settles with; `linkKey` links the stub so a later
// session can resume (unlinked sessions never park a watermark).
async function renderCard(
  over: Record<string, unknown> = {},
  { entries, linkKey }: { entries?: ActionLogEntry[]; linkKey?: string } = {},
) {
  const log = entry(1, over)
  const server = makeOverseer()
  const chat = withChatApi(server)
  if (linkKey !== undefined) linkActionLog(server.overseer, linkKey)
  await renderChat(server.overseer, { selectedChatId: 1 })
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: entries ?? [log] })
  chat.emitMessage({ ...actionMessage, actionLog: log } as AiChatMessage)
  flushFrames()
}

// A first session that caches a pending card, with a second pending action behind it.
function cachePendingCard(linkKey?: string) {
  return renderCard({}, { entries: [entry(1), entry(2)], linkKey })
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

  it('shows a veto refused while disconnected as already applied', async () => {
    const vetoed = { state: 'rejected', appliedAt: new Date(1700005000000) }
    await renderCard(vetoed, { entries: [] })

    const refused = entry(1, {
      state: 'approved', vetoRefused: true, appliedAt: new Date(1700006000000),
    })
    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(async () =>
      ({ ...actionMessage, actionLog: refused }) as AiChatMessage))
    await renderChat(second.overseer, { selectedChatId: 1 })
    await second.resolveSubscription()
    await second.resolvePendingQuery({ entries: [] })
    await vi.waitFor(() => expect(secondChat.getChatMessage).toHaveBeenCalledWith(1, 0))
    flushFrames()

    expect(document.body.textContent).toContain('Already applied')
    expect(document.body.textContent).not.toContain('Denied')
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

  it('does not let a stale refresh drop a failure recorded while it was in flight', async () => {
    await cachePendingCard()

    let resolveFetch!: (message: AiChatMessage | null) => void
    const fetched = new Promise<AiChatMessage | null>(resolve => { resolveFetch = resolve })
    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(() => fetched))
    await renderChat(second.overseer, { selectedChatId: 1 })
    await vi.waitFor(() => expect(secondChat.getChatMessage).toHaveBeenCalledWith(1, 0))
    await second.resolveSubscription()
    await second.resolvePendingQuery({ entries: [entry(1), entry(2)] })
    // An apply stops while the refresh is in flight: the card stays pending, so resolution
    // monotonicity says nothing -- only the stop's own stamp distinguishes the two reads.
    await second.emit(entry(1, {
      failure: 'page was deleted upstream',
      appliedAt: new Date(1700005000000),
    }))
    flushFrames()

    await act(async () => resolveFetch(actionMessage))
    flushFrames()

    expect(document.body.textContent).toContain('page was deleted upstream')
  })
})

describe('ChatInterface action failure note', () => {
  it("shows the gatekeeper's reason on a pending action card", async () => {
    await renderCard({ failure: 'page was deleted upstream' })

    expect(document.body.textContent).toContain('page was deleted upstream')
  })
})

// A pending action whose description runs to several paragraphs.
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
async function renderPendingCard(log: ActionLogEntry) {
  const server = makeOverseer()
  const chat = withChatApi(server, undefined, [
    { id: 1, title: 'Chat', started: new Date(), lastActive: new Date() },
  ])
  await renderChat(server.overseer, { selectedChatId: 1 })
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [log] })
  chat.emitMessage({ ...actionMessage, actionLog: log } as AiChatMessage)
}

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

describe('ChatInterface pending action card', () => {
  it('sends the reviewer to the action’s own connection instead of deciding here', async () => {
    await renderCard({ gatekeeperId: 4, description: { title: 'Action 1', description: '', implementsRevert: false, awaitDecision: true } })

    const button = [...document.querySelectorAll('button')]
      .find(node => node.textContent === 'Review actions')
    expect(button).toBeDefined()
    expect(document.body.textContent).not.toContain('Approve')
    expect(document.body.textContent).not.toContain('Always approve')

    act(() => button!.click())

    // Opening the review decides nothing: the card stays pending until the server says otherwise.
    expect(onReviewActions).toHaveBeenCalledWith(4)
    expect(document.body.textContent).toContain('Review actions')
  })
})

describe('ChatInterface action status', () => {
  it('presents a cascade invalidation as invalidated rather than denied', async () => {
    await renderCard({ state: 'rejected', cascadedFrom: 2 })

    expect(document.body.textContent).toContain('Invalidated')
    expect(document.body.textContent).not.toContain('Denied')
  })

  it('presents a direct rejection as denied', async () => {
    await renderCard({ state: 'rejected' })

    expect(document.body.textContent).toContain('Denied')
    expect(document.body.textContent).not.toContain('Invalidated')
  })

  it('presents a refused veto as already applied rather than approved', async () => {
    await renderCard({ state: 'approved', vetoRefused: true })

    // The user asked for the opposite, so the bare state would read as a verdict they never gave.
    expect(document.body.textContent).toContain('Already applied')
    expect(document.body.textContent).not.toContain('Approved')
  })
})
