// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiChatMessage, AiChatSubscriber, Overseer } from '@gadgets/workshop-shared/api'

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
// jsdom implements neither, and the thread view scrolls itself to the newest message on render.
Element.prototype.scrollTo = () => {}
Element.prototype.scrollIntoView = () => {}

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
import { linkActionLog } from './useActions'

const testRoot = makeTestRoot()

afterEach(() => {
  testRoot.cleanup()
  vi.restoreAllMocks()
})

function withChatApi(
  server: ReturnType<typeof makeOverseer>,
  getChatMessage = vi.fn<(chatId: number, sequence: number) => Promise<AiChatMessage | null>>(),
) {
  let subscriber: AiChatSubscriber | undefined
  Object.assign(server.overseer as object, {
    getChatMessage,
    getChatHistory: async () => ({ messages: [] }),
    listChats: async () => [],
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

function renderChat(overseer: RpcStub<Overseer>, selectedChatId: number | null = null) {
  return testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={overseer}
      selectedChatId={selectedChatId}
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
  await renderChat(first.overseer, 1)
  await first.resolveSubscription()
  await first.resolvePendingQuery({ entries: [entry(1), entry(2)] })
  firstChat.emitMessage(actionMessage)
  flushFrames()
}

describe('ChatInterface action refresh', () => {
  it('shows a missed failure on a cached card after a stub swap', async () => {
    await cachePendingCard()

    const failed = entry(1, { failure: 'page was deleted while disconnected' })
    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(async () =>
      ({ ...actionMessage, actionLog: failed }) as AiChatMessage))
    await renderChat(second.overseer, 1)
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
    await renderChat(second.overseer, 1)
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
    await renderChat(second.overseer, 1)
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
    await renderChat(server.overseer, 1)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [failed] })
    chat.emitMessage({ ...actionMessage, actionLog: failed } as AiChatMessage)

    expect(document.body.textContent).toContain('page was deleted upstream')
  })
})
