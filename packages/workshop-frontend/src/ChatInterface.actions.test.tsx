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

function renderChat(overseer: RpcStub<Overseer>) {
  return testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={overseer}
      selectedChatId={null}
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

// Renders a first session that caches a pending action card, then swaps in a fresh linked stub.
async function cachePendingCard() {
  const first = makeOverseer()
  const firstChat = withChatApi(first)
  linkActionLog(first.overseer, 'workspace')
  await renderChat(first.overseer)
  await first.resolveSubscription()
  await first.resolvePendingQuery({ entries: [entry(1)] })
  firstChat.emitMessage(actionMessage)
}

describe('ChatInterface action refresh', () => {
  it('refreshes cached action cards when a resumed subscription fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await cachePendingCard()

    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(async () => resolvedMessage))
    linkActionLog(second.overseer, 'workspace')
    await renderChat(second.overseer)
    expect(secondChat.getChatMessage).not.toHaveBeenCalled()

    await second.rejectSubscription(new Error('replay failed'))
    await vi.waitFor(() => expect(secondChat.getChatMessage).toHaveBeenCalledWith(1, 0))
  })

  it('retries cards a failed refetch left behind on the next resumed reconnect', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await cachePendingCard()

    // Resumed swap whose replay fails: the fallback refetch runs but the card fetch errors.
    const second = makeOverseer()
    const secondChat = withChatApi(second, vi.fn(async () => {
      throw new Error('fetch failed')
    }))
    linkActionLog(second.overseer, 'workspace')
    await renderChat(second.overseer)
    await second.rejectSubscription(new Error('replay failed'))
    await vi.waitFor(() => expect(secondChat.getChatMessage).toHaveBeenCalled())

    // The next session resumes cleanly, yet the unrepaired card is still retried.
    const third = makeOverseer()
    const thirdChat = withChatApi(third, vi.fn(async () => resolvedMessage))
    linkActionLog(third.overseer, 'workspace')
    await renderChat(third.overseer)
    await vi.waitFor(() => expect(thirdChat.getChatMessage).toHaveBeenCalledWith(1, 0))
  })
})
