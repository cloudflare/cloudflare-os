// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type * as Kumo from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type {
  AiChatHistoryPage, AiChatMessage, AiChatMessageBody, AiChatMetadata, AiChatSubscriber, Overseer,
} from '@gadgets/workshop-shared/api'
import type { CodeChange } from '@gadgets/workshop-shared/code-change'

// A revert that reaches past the oldest loaded compaction boundary changes that boundary on the
// server. The code view must not rebuild on the cached copy, and must recover when the refetch
// fails.

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  disconnect() {}
})
// jsdom lays nothing out; the message list scrolls itself to the bottom on every render.
Element.prototype.scrollTo = () => {}
// A message list taller than its viewport, so the client leaves the pages before the boundary
// unloaded rather than fetching them to fill the screen.
Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 1000 })

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal<typeof Kumo>()
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

import { makeOverseer, makeTestRoot } from './action-test-harness'
import ChatInterface, { type ChatCodeChanges } from './ChatInterface'

const testRoot = makeTestRoot()

afterEach(() => {
  testRoot.cleanup()
  vi.restoreAllMocks()
})

const CHAT_ID = 1
const USER = { type: 'user', id: 'dev', name: 'Dev' } as const
const PRE_BOUNDARY: CodeChange = { 4: [['pre.txt', { set: 'pre' }]] }
const LOADED: CodeChange = { 4: [['loaded.txt', { set: 'loaded' }]] }

const message = (sequence: number, body: AiChatMessageBody): AiChatMessage => ({
  chatId: CHAT_ID,
  sequence,
  timestamp: new Date(1700000000000 + sequence),
  author: USER,
  ...body,
})

const metadata = (generation: number): AiChatMetadata => ({
  id: CHAT_ID,
  title: 'Chat',
  started: new Date(1700000000000),
  lastActive: new Date(1700000000000),
  compactedTo: 10,
  codeBase: { pins: [], generation, revision: 0 },
})

// The newest page, whose boundary still proposes a change from before it.
const TAIL: AiChatHistoryPage = {
  messages: [message(10, { type: 'changes', change: LOADED })],
  compacted: { to: 10, summary: 'Earlier work', proposedChange: PRE_BOUNDARY },
}

// The same page once a revert from 0 discarded every proposed change.
const REFOLDED: AiChatHistoryPage = {
  messages: TAIL.messages,
  compacted: { to: 10, summary: 'Earlier work' },
}

type OnChatChangesChange = (changes: ChatCodeChanges | undefined) => void

// Renders the compacted chat over a fresh overseer, as a reconnect does when one is already
// rendered. The server answers with `newest` for the newest page, and runs `refetch` for the
// boundary's own page.
async function openChat(
  newest: AiChatHistoryPage,
  refetch: () => Promise<AiChatHistoryPage>,
  onChatChangesChange: OnChatChangesChange,
) {
  const server = makeOverseer()
  let subscriber: AiChatSubscriber | undefined
  const getChatHistory =
    vi.fn<(chatId: number, beforeSequence?: number) => Promise<AiChatHistoryPage>>(
      async (_chatId, beforeSequence) => beforeSequence === undefined ? newest : refetch())
  Object.assign(server.overseer as object, {
    getChatMessage: async () => null,
    getChatHistory,
    listChats: async () => [metadata(0)],
    listModels: async () => [],
    onRpcBroken: () => {},
    subscribeToChat: (next: AiChatSubscriber) => {
      subscriber = next
      return { [Symbol.dispose]: () => {} }
    },
  })
  await testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={server.overseer as RpcStub<Overseer>}
      selectedChatId={CHAT_ID}
      onNavigateToChat={() => {}}
      onChatChangesChange={onChatChangesChange}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}}
      outputOfWorkpiece={() => undefined}
    />,
  )
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [] })
  return {
    getChatHistory,
    // Delivers a revert as the server does: the message, then the metadata's generation bump.
    async revertFromStart() {
      await act(async () => {
        subscriber!.message(message(11, { type: 'revert', revertFrom: 0 }))
        subscriber!.metadata(metadata(1))
      })
    },
  }
}

const filesOf = (changes: ChatCodeChanges | undefined) =>
  Object.values(changes?.epochChange ?? {}).flat().map(([path]) => path).toSorted()

it('holds the code view until a refetch of the boundary succeeds, retrying on reconnect',
    async () => {
  const views: (ChatCodeChanges | undefined)[] = []
  const onChatChangesChange: OnChatChangesChange = changes => { views.push(changes) }
  const first = await openChat(TAIL, async () => { throw new Error('connection lost') },
                               onChatChangesChange)
  expect(filesOf(views.at(-1))).toEqual(['loaded.txt', 'pre.txt'])

  const beforeRevert = views.length
  await first.revertFromStart()
  expect(first.getChatHistory).toHaveBeenCalledWith(CHAT_ID, 11)
  expect(views.length).toBeGreaterThan(beforeRevert)
  expect(views.slice(beforeRevert).every(view => view === undefined)).toBe(true)

  const second = await openChat(REFOLDED, async () => REFOLDED, onChatChangesChange)
  expect(second.getChatHistory).toHaveBeenCalledWith(CHAT_ID, 11)
  expect(views.at(-1)).toMatchObject({ chatId: CHAT_ID, epochChange: undefined })
})
