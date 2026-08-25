// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
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

import { entry, makeOverseer } from './action-test-harness'
import ChatInterface from './ChatInterface'
import { linkActionLog } from './useActions'

const roots: Array<ReturnType<typeof createRoot>> = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount())
  document.body.replaceChildren()
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

function renderChat(root: ReturnType<typeof createRoot>, overseer: RpcStub<Overseer>) {
  return act(async () => root.render(
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
  ))
}

describe('ChatInterface action refresh', () => {
  it('refreshes cached action cards when a resumed subscription fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)

    const first = makeOverseer()
    const firstChat = withChatApi(first)
    linkActionLog(first.overseer, 'workspace')
    await renderChat(root, first.overseer)
    await first.resolveSubscription()
    await first.resolvePendingQuery({ entries: [entry(1)] })

    const message = {
      chatId: 1,
      sequence: 0,
      timestamp: new Date(),
      author: { type: 'agent', id: 'model', name: 'Model' },
      type: 'action',
      actionId: 1,
      actionLog: entry(1),
    } as AiChatMessage
    firstChat.emitMessage(message)

    const second = makeOverseer()
    const refreshed = { ...message, actionLog: entry(1, { state: 'approved' }) } as AiChatMessage
    const secondChat = withChatApi(second, vi.fn(async () => refreshed))
    linkActionLog(second.overseer, 'workspace')
    await renderChat(root, second.overseer)
    expect(secondChat.getChatMessage).not.toHaveBeenCalled()

    await second.rejectSubscription(new Error('replay failed'))
    await vi.waitFor(() => expect(secondChat.getChatMessage).toHaveBeenCalledWith(1, 0))
  })
})
