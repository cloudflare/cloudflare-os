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

function pendingLog(over: Partial<Record<string, unknown>> = {}) {
  return entry(1, {
    description: { title: 'Send email', description: 'Send an email.', implementsRevert: false, ...over },
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

    expect(document.body.textContent).toContain('Send an email.')
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
      expect(document.body.textContent).toContain('Send an email.')
    })
  }
})
