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

import { entry, makeOverseer, makeTestRoot } from './action-test-harness'
import ChatInterface from './ChatInterface'
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
}

const clampedDescription = () => document.querySelector('[class*="max-h-[200px]"]')

describe('restricted approval', () => {
  it('shows the notice and the full request on a pending card while restricted', async () => {
    await renderPendingCard(pendingLog(), { restricted: true })

    expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY)
    expect(document.body.textContent).toContain('Regards, the workspace.')
    expect(clampedDescription()).toBeNull()
  })

  it('shows the notice and the full request on a blocking card while restricted', async () => {
    await renderPendingCard(pendingLog({ awaitDecision: true }), { restricted: true })

    expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY)
    expect(clampedDescription()).toBeNull()
  })

  it('keeps the scrolling description and no notice when not restricted', async () => {
    await renderPendingCard(pendingLog())

    expect(document.body.textContent).not.toContain(RESTRICTED_APPROVAL_COPY)
    expect(clampedDescription()).not.toBeNull()
  })
})
