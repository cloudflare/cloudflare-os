// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatMessage, AiChatMetadata, AiChatSubscriber, BlueprintMerge, MergeChangesResult, Overseer,
} from '@gadgets/workshop-shared/api'
import type { CodeContent } from '@gadgets/workshop-shared/code-change'

// Covers a blueprint proposal as the chat shows it: the notice in the transcript, accept and
// discard for a proposal that the chat's metadata does not announce, and the check for
// unresolved conflicts that stands in front of accepting.

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
  // A dialog shows what is in it while it is open, without the portal and focus handling.
  const Dialog = new Proxy(Pass, {
    get: (_target, property) => property === 'Root'
      ? ({ open, children }: { open?: boolean, children?: React.ReactNode }) => open ? children : null
      : property === 'Close' ? Null : Pass,
  })
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return {
    ...actual,
    Dialog,
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
import ChatInterface from './ChatInterface'

const testRoot = makeTestRoot()

afterEach(() => {
  testRoot.cleanup()
  vi.restoreAllMocks()
})

const CHAT_ID = 1
const GADGET_ID = 4

const USER = { type: 'user', id: 'dev', name: 'Dev' } as const

const CONFLICTED = [
  '<<<<<<< this gadget',
  'const days = 3',
  '||||||| base',
  'const days = 1',
  '=======',
  'const days = 7',
  '>>>>>>> blueprint',
  '',
].join('\n')

const merge = (over: Partial<BlueprintMerge> = {}): BlueprintMerge => ({
  gadgetId: GADGET_ID,
  blueprintId: 'blueprint',
  title: 'Trip planner',
  version: 3,
  commitId: 'release',
  kind: 'merge',
  baseCommit: 'base',
  conflictPaths: [],
  ...over,
})

const changes = (
  sequence: number, over: Partial<Extract<AiChatMessage, { type: 'changes' }>>,
): AiChatMessage => ({
  chatId: CHAT_ID,
  sequence,
  timestamp: new Date(1700000000000 + sequence),
  author: USER,
  type: 'changes',
  ...over,
})

const chatMetadata = (over: Partial<AiChatMetadata> = {}): AiChatMetadata => ({
  id: CHAT_ID,
  title: 'Update from blueprint: Trip planner',
  started: new Date(1700000000000),
  lastActive: new Date(1700000000000),
  ...over,
})

// Renders the chat as it is right after `applyBlueprint` made it: its metadata, and a history
// that is the proposal alone. `content` is what the code view holds of the chat's files.
async function renderProposalChat(options: {
  metadata?: AiChatMetadata
  history: AiChatMessage[]
  content?: () => CodeContent | undefined
  // Whether the code view holds edits that the server has yet to acknowledge.
  hasLocalEdits?: () => boolean
}) {
  const server = makeOverseer()
  const mergeChanges = vi.fn<(chatId: number) => Promise<MergeChangesResult>>(
    async () => ({ outcome: 'merged' }))
  let subscriber: AiChatSubscriber | undefined
  Object.assign(server.overseer as object, {
    getChatMessage: async () => null,
    getChatHistory: async () => ({ messages: options.history }),
    listChats: async () => [options.metadata ?? chatMetadata()],
    listModels: async () => [],
    onRpcBroken: () => {},
    subscribeToChat: (next: AiChatSubscriber) => {
      subscriber = next
      return { [Symbol.dispose]: () => {} }
    },
    mergeChanges,
  })

  await testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={server.overseer as RpcStub<Overseer>}
      selectedChatId={CHAT_ID}
      onNavigateToChat={() => {}}
      chatContent={options.content && {
        chatId: CHAT_ID,
        read: options.content,
        hasLocalEdits: options.hasLocalEdits ?? (() => false),
      }}
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
    mergeChanges,
    emitMessage(message: AiChatMessage) {
      act(() => subscriber!.message(message))
    },
  }
}

const button = (label: string) =>
  [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === label)

async function click(label: string) {
  const target = button(label)
  if (!target) throw new Error(`No "${label}" button rendered`)
  await act(async () => { target.click() })
}

const text = () => document.body.textContent ?? ''

describe('blueprint proposal notice', () => {
  it('describes a merge from its record, in place of a saved-edits row', async () => {
    await renderProposalChat({
      metadata: chatMetadata({ proposedChangeWorkpieces: [GADGET_ID] }),
      history: [
        changes(0, {
          blueprintMerges: [merge({ conflictPaths: ['client.js'] })],
          pins: [{ gadgetId: GADGET_ID, baseCommit: 'head' }],
          change: { [GADGET_ID]: [['client.js', { set: CONFLICTED }]] },
        }),
      ],
    })

    expect(text()).toContain('Trip planner, version 3')
    expect(text()).toContain('have both changed')
    expect(text()).toContain('The merge left conflicts in 1 file: client.js.')
    expect(text()).toContain('Nothing changes until you accept.')
    expect(text()).not.toContain('saved edits')
  })

  it('folds the rest of a split merge into the notice', async () => {
    await renderProposalChat({
      metadata: chatMetadata({ proposedChangeWorkpieces: [GADGET_ID] }),
      history: [
        changes(0, {
          blueprintMerges: [merge({ messageCount: 3 })],
          pins: [{ gadgetId: GADGET_ID, baseCommit: 'head' }],
          change: { [GADGET_ID]: [['client.js', { set: 'one' }]] },
        }),
        changes(1, { change: { [GADGET_ID]: [['server.js', { set: 'two' }]] } }),
        changes(2, { change: { [GADGET_ID]: [['styles.css', { set: 'three' }]] } }),
        // An edit someone made afterwards is still theirs.
        changes(3, { change: { [GADGET_ID]: [['client.js', { set: 'four' }]] } }),
      ],
    })

    expect(text()).toContain('Trip planner, version 3')
    expect(text().match(/saved edits/g)).toHaveLength(1)
  })

  it('leaves a line saying which way the proposal was decided', async () => {
    const chat = await renderProposalChat({
      history: [changes(0, { blueprintMerges: [merge({ kind: 'follow', baseCommit: undefined })] })],
    })
    expect(text()).toContain('Nothing changes until you accept.')

    chat.emitMessage({
      chatId: CHAT_ID, sequence: 1, timestamp: new Date(), author: USER, type: 'revert', revertFrom: 0,
    })

    expect(text()).toContain('Blueprint update: Trip planner, version 3 · discarded')
    expect(text()).not.toContain('Nothing changes until you accept.')
  })
})

describe('accepting a proposal that the chat’s metadata does not announce', () => {
  // The release is already in the gadget's history and no file changes, so the chat pins
  // nothing and proposes changes to no workpiece.
  const follow = changes(0, { blueprintMerges: [merge({ kind: 'follow', baseCommit: undefined })] })

  it('offers accept and discard while the proposal is still to be decided', async () => {
    const chat = await renderProposalChat({ history: [follow] })

    expect(text()).toContain('Pending changes')
    await click('Accept changes')
    expect(chat.mergeChanges).toHaveBeenCalledExactlyOnceWith(CHAT_ID)
  })

  it('stops offering them once the proposal is accepted', async () => {
    const chat = await renderProposalChat({ history: [follow] })

    chat.emitMessage({
      chatId: CHAT_ID, sequence: 1, timestamp: new Date(), author: USER,
      type: 'merge', mergeThrough: 0, commits: [],
    })

    expect(button('Accept changes')).toBeUndefined()
    expect(text()).toContain('Blueprint update: Trip planner, version 3 · accepted')
  })
})

describe('accepting changes with unresolved merge conflicts', () => {
  const conflicted = changes(0, {
    blueprintMerges: [merge({ conflictPaths: ['client.js'] })],
    pins: [{ gadgetId: GADGET_ID, baseCommit: 'head' }],
    change: { [GADGET_ID]: [['client.js', { set: CONFLICTED }]] },
  })
  const metadata = chatMetadata({ proposedChangeWorkpieces: [GADGET_ID] })
  const contentOf = (clientJs: string): CodeContent =>
    new Map([[GADGET_ID, new Map([['client.js', clientJs]])]])

  it('holds the accept while a conflicted file still has markers, and lets it through after', async () => {
    let content = contentOf(CONFLICTED)
    const chat = await renderProposalChat({ metadata, history: [conflicted], content: () => content })

    await click('Accept changes')
    expect(chat.mergeChanges).not.toHaveBeenCalled()
    expect(text()).toContain('This draft still has merge conflicts')
    expect(text()).toContain('line 1')

    await click('Keep resolving')
    expect(text()).not.toContain('This draft still has merge conflicts')
    expect(chat.mergeChanges).not.toHaveBeenCalled()

    content = contentOf('const days = 7\n')
    await click('Accept changes')
    expect(text()).not.toContain('This draft still has merge conflicts')
    expect(chat.mergeChanges).toHaveBeenCalledExactlyOnceWith(CHAT_ID)
  })

  it('accepts the markers when the user says to', async () => {
    const chat = await renderProposalChat({
      metadata, history: [conflicted], content: () => contentOf(CONFLICTED),
    })

    await click('Accept changes')
    await click('Accept anyway')
    expect(chat.mergeChanges).toHaveBeenCalledExactlyOnceWith(CHAT_ID)
    expect(text()).not.toContain('This draft still has merge conflicts')
  })

  it('checks the files of a mainline merge too', async () => {
    const chat = await renderProposalChat({
      metadata,
      history: [
        changes(0, {
          mainlineMerge: { conflictPaths: ['PLANNER/client.js'] },
          change: { [GADGET_ID]: [['client.js', { set: CONFLICTED }]] },
        }),
      ],
      content: () => contentOf(CONFLICTED),
    })

    await click('Accept changes')
    expect(chat.mergeChanges).not.toHaveBeenCalled()
    expect(text()).toContain('This draft still has merge conflicts')
  })

  // The server merges what it has been sent. An edit still on its way there may be the one
  // that removed the last marker, which the content on screen already shows as gone.
  it('waits for edits that the server has yet to receive', async () => {
    let unsent = true
    const chat = await renderProposalChat({
      metadata,
      history: [conflicted],
      content: () => contentOf('const days = 7\n'),
      hasLocalEdits: () => unsent,
    })

    await click('Accept changes')
    expect(chat.mergeChanges).not.toHaveBeenCalled()

    unsent = false
    await click('Accept changes')
    expect(chat.mergeChanges).toHaveBeenCalledExactlyOnceWith(CHAT_ID)
  })

  // Typing through an accept is ordinarily fine: the edits land after it. Only a chat with
  // conflicts to check has a reason to wait for them.
  it('does not wait for unsent edits in a chat with no conflicts listed', async () => {
    const chat = await renderProposalChat({
      metadata,
      history: [changes(0, {
        pins: [{ gadgetId: GADGET_ID, baseCommit: 'head' }],
        change: { [GADGET_ID]: [['client.js', { set: 'const days = 7\n' }]] },
      })],
      content: () => contentOf('const days = 7\n'),
      hasLocalEdits: () => true,
    })

    await click('Accept changes')
    expect(chat.mergeChanges).toHaveBeenCalledExactlyOnceWith(CHAT_ID)
  })

  // The check is the client's own, so a chat whose content has yet to load is not held up.
  it('accepts unchecked while the chat’s content has not loaded', async () => {
    const chat = await renderProposalChat({ metadata, history: [conflicted], content: () => undefined })

    await click('Accept changes')
    expect(chat.mergeChanges).toHaveBeenCalledExactlyOnceWith(CHAT_ID)
  })
})
