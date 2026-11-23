// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { DEFAULT_CHAT_MODE } from './modelSelection'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  ActionLogEntry, AiChatMessage, AiChatMetadata, AiChatStreamEvent, AiChatSubscriber, Overseer,
  WorkpieceSummary,
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

// A test of the remembered new-chat mode signs a user in; the rest run with nobody confirmed.
const auth = vi.hoisted(() => ({
  authenticatedApi: { listGatekeeperVendors: async () => [] },
  currentUser: null as { id: string } | null,
  isCurrentUserConfirmed: false,
}))
vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => auth,
  useOptionalAuthenticatedApi: () => null,
}))
// The menu itself is tested beside it; here, what the chat shows in it and does with a choice.
vi.mock('./features/chat/composer/ComposerModeSelector', () => ({
  ComposerModeSelector: ({ mode, restricted, onModeChange }: {
    mode: string, restricted: boolean, onModeChange?: (mode: string) => void
  }) => (
    <div data-testid="mode" data-mode={mode} data-restricted={String(restricted)}
      data-readonly={String(onModeChange === undefined)}>
      {onModeChange && ['auto', 'review', 'fork'].map(choice => (
        <button key={choice} type="button" onClick={() => onModeChange(choice)}>{`Mode ${choice}`}</button>
      ))}
    </div>
  ),
}))
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
import type { ChatWithChanges } from './features/approvals/chatsWithChanges'

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
    // Read by the pending-changes tray, for its connections' vendors.
    listPreApprovableActions: async () => [],
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
  props: {
    restricted?: boolean, selectedChatId?: number, modeReadOnly?: boolean,
    onChatsWithChangesChange?: (chats: readonly ChatWithChanges[]) => void,
    onOpenWorkpieceCode?: (workpieceId: number) => void,
    workpieces?: WorkpieceSummary[],
  } = {},
) {
  return testRoot.render(
    <ChatInterface
      workspaceId="workspace"
      overseer={overseer}
      restricted={props.restricted}
      modeReadOnly={props.modeReadOnly}
      onChatsWithChangesChange={props.onChatsWithChangesChange}
      selectedChatId={props.selectedChatId ?? null}
      onNavigateToChat={() => {}}
      pendingConsoleLogCount={0}
      consoleLogPreview=""
      consoleLogSeverity="info"
      onConsumeConsoleLogs={() => ''}
      onDiscardConsoleLogs={() => {}}
      onOpenGadget={() => {}} onOpenFocus={() => {}}
      onOpenWorkpieceCode={props.onOpenWorkpieceCode ?? (() => {})}
      workpieceOf={(id) => props.workpieces?.find(workpiece => workpiece.id === id)}
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

// Made in chat 1, so the tray shows it there.
function pendingLog(over: Partial<Record<string, unknown>> = {}) {
  return entry(1, {
    chatId: 1,
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
    { id: 1, title: 'Chat', mode: 'auto', started: new Date(), lastActive: new Date() },
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
 * A non-blocking request is reviewed in the tray above the composer rather than in the
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

// The text a screen reader announces as the description of the first Approve button (the
// blocking card's), or of the last Deny button (the tray's, below the transcript).
function approveDescribedBy(): string | null {
  return describedBy([...document.querySelectorAll('button')].find(b => b.textContent === 'Approve'))
}
function trayDenyDescribedBy(): string | null {
  return describedBy([...document.querySelectorAll('button')].filter(b => b.textContent === 'Deny').at(-1))
}
function describedBy(button: HTMLButtonElement | undefined): string | null {
  if (!button) throw new Error('No such button rendered')
  const ids = button.getAttribute('aria-describedby')
  if (ids === null) return null
  return ids.split(' ').map(id => {
    const el = document.getElementById(id)
    if (!el) throw new Error(`aria-describedby names a missing element: ${id}`)
    return el.textContent ?? ''
  }).join('\n')
}

describe('the pending queue', () => {
  it('keeps the requests no chat made on screen after going back to the conversation list',
      async () => {
    // A request from a hook or a scheduled task belongs to no conversation at all. Accepting a
    // chat that acted on its connection applies it first, so that chat's tray shows it, and so
    // does the conversation list's, where no chat's accept covers it.
    const server = makeOverseer()
    withChatApi(server, undefined, [
      { id: 1, title: 'Chat', mode: 'auto', started: new Date(), lastActive: new Date() },
    ])
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(1), entry(2, { chatId: 1 })] })

    expect(document.body.textContent).toContain('2 requests waiting')

    // Back to the conversation list, with the requests still pending.
    await renderChat(server.overseer, {})
    expect(document.body.textContent).toContain('1 request waiting')
  })
})

describe('accepting a chat', () => {
  it("accepts a chat's requests from its pending-changes bar, and leaves only Deny on its cards",
      async () => {
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [
      { id: 1, title: 'Chat', mode: 'auto', started: new Date(), lastActive: new Date() },
    ])
    const mergeChanges = vi.fn<Overseer['mergeChanges']>(async () => ({ outcome: 'merged' }))
    Object.assign(server.overseer as object, { mergeChanges })
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    const log = { ...pendingLog(), chatId: 1 } as ActionLogEntry
    await server.resolvePendingQuery({ entries: [log, { ...entry(2), chatId: 2 } as ActionLogEntry] })
    chat.emitMessage({ ...actionMessage, actionLog: log } as AiChatMessage)

    // Another chat's request is not this chat's to accept, and appears nowhere here.
    expect(document.body.textContent).toContain('1 request waiting')
    expect(document.body.textContent).toContain('Pending changes')
    expect(document.body.textContent).not.toContain('request to apply')
    const labels = [...document.querySelectorAll('button')].map(b => b.textContent?.trim())
    expect(labels).toContain('Deny')
    expect(labels).not.toContain('Approve')
    expect(labels).not.toContain('Discard all')

    const accept = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.includes('Accept changes'))
    await act(async () => accept!.click())
    // Bounded by the highest request shown, which leaves out the other chat's later one.
    expect(mergeChanges).toHaveBeenCalledWith(1, { through: 1 })
  })

  it('keeps Approve on a request the agent is waiting on', async () => {
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [
      { id: 1, title: 'Chat', mode: 'auto', started: new Date(), lastActive: new Date() },
    ])
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    const log = { ...pendingLog({ awaitDecision: true }), chatId: 1 } as ActionLogEntry
    await server.resolvePendingQuery({ entries: [log] })
    chat.emitMessage({ ...actionMessage, actionLog: log } as AiChatMessage)
    expect([...document.querySelectorAll('button')].map(b => b.textContent)).toContain('Approve')
  })

  it.each([true, false])(
      'holds back Accept changes only while the agent is stopped on a decision (%s)',
      async (awaitingDecision) => {
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [{
      id: 1, title: 'Chat', mode: 'auto', started: new Date(), lastActive: new Date(),
      ...(awaitingDecision ? { awaitingDecision: true as const } : {}),
    }])
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    // A stopped turn leaves its awaited request pending without waiting on it any longer.
    const log = { ...pendingLog({ awaitDecision: true }), chatId: 1 } as ActionLogEntry
    await server.resolvePendingQuery({ entries: [log] })
    chat.emitMessage({ ...actionMessage, actionLog: log } as AiChatMessage)

    const accept = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === 'Accept changes') as HTMLButtonElement
    expect(accept.disabled).toBe(awaitingDecision)
  })

  it('holds back Accept changes until every pending request is known', async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [{
      id: 1, title: 'Chat', mode: 'auto', started: new Date(), lastActive: new Date(),
      proposedChangeWorkpieces: [1],
    }])
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    const accept = () => [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === 'Accept changes') as HTMLButtonElement
    // The accept would apply the chat's requests, and they have not loaded to be shown yet.
    expect(accept().disabled).toBe(true)

    await server.resolvePendingQuery({ entries: [{ ...entry(1), chatId: 1 } as ActionLogEntry] })
    expect(accept().disabled).toBe(false)
  })

  it('holds back a Retry that accepts the chat until every pending request is known', async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [
      { id: 1, title: 'Chat', mode: 'auto', started: new Date(), lastActive: new Date() },
    ])
    const mergeChanges = vi.fn<Overseer['mergeChanges']>(async () => ({ outcome: 'merged' }))
    Object.assign(server.overseer as object, { mergeChanges })
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    const failed = entry(5, { chatId: 1, applyError: { message: 'Quota exceeded.', retryable: true } })
    const retry = async () => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent === 'Retry')
      await act(async () => button!.click())
    }
    // An older page, with requests the accept would apply too, has not loaded.
    await server.resolvePendingQuery({ entries: [failed], nextBeforeId: 5 })
    await act(async () => flushFrames())
    await openTray()
    await retry()
    expect(mergeChanges).not.toHaveBeenCalled()

    await server.resolvePendingQuery({ entries: [] })
    await retry()
    expect(mergeChanges).toHaveBeenCalledWith(1, { through: 5 })
  })

  it('accepts the held requests no chat made from the bar under the tray, outside any chat',
      async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [])
    const acceptStagedActions = vi.fn<Overseer['acceptStagedActions']>(
      async () => ({ outcome: 'applied' }))
    Object.assign(server.overseer as object, { acceptStagedActions })
    await renderChat(server.overseer)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(1), { ...entry(2), chatId: 2 } as ActionLogEntry] })

    expect(document.body.textContent).toContain('Held changes')
    const accept = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.includes('Accept changes'))
    await act(async () => accept!.click())
    // Bounded by the highest held request shown, not by the chat's later one.
    expect(acceptStagedActions).toHaveBeenCalledExactlyOnceWith(1)
  })

  it('shows the bar in a chat in Fork with nothing to accept, and offers no accept', async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date(), mode: 'fork' },
    ])
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [] })

    expect(document.body.textContent).toContain('No pending changes')
    const accept = [...document.querySelectorAll('button')]
      .find(b => b.textContent?.includes('Accept changes'))
    expect(accept?.disabled).toBe(true)
  })

  it('reports the chats with changes waiting, for the Activity page', async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [
      { id: 1, title: 'Busy', mode: 'auto', started: new Date(), lastActive: new Date(), pendingActions: 1 },
      { id: 2, title: 'Idle', mode: 'auto', started: new Date(), lastActive: new Date() },
    ])
    const reported = vi.fn<(chats: readonly ChatWithChanges[]) => void>()
    await renderChat(server.overseer, { onChatsWithChangesChange: reported })
    await server.resolveSubscription()
    expect(reported).toHaveBeenLastCalledWith([
      { id: 1, title: 'Busy', requests: 1, codeChanges: false, holding: false, awaitingDecision: false },
    ])
  })
});

const agent = { type: 'agent', id: 'model', name: 'Model' } as const

// Chat 1 selected in `mode`, its agent running or not, with `entries` pending.
async function renderModeChat({ mode, running, entries, over = {} }: {
  mode: AiChatMetadata['mode'], running: boolean, entries: ActionLogEntry[],
  over?: Partial<AiChatMetadata>,
}) {
  const server = makeOverseer()
  withChatApi(server, undefined, [{
    id: 1, title: 'Chat', started: new Date(), lastActive: new Date(), mode,
    pendingActions: entries.length, ...(running ? { activeAgent: agent } : {}), ...over,
  }])
  await renderChat(server.overseer, { selectedChatId: 1 })
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries })
}

const buttonLabels = () => [...document.querySelectorAll('button')].map(b => b.textContent?.trim())
const reviewLabels = () => (document.body.textContent ?? '').split('Needs review').length - 1

describe('the pending-changes bar by mode', () => {
  const autoApprovable = () => pendingLog({ autoApprovable: true }) as ActionLogEntry

  it('offers no accept mid-turn in Auto while everything pending is auto-approvable', async () => {
    await renderModeChat({ mode: 'auto', running: true, entries: [autoApprovable()] })

    expect(document.body.textContent).toContain('1 request waiting')
    expect(document.body.textContent).toContain('accepted when the agent finishes')
    expect(buttonLabels()).not.toContain('Accept changes')
  })

  it('offers no accept mid-turn in Auto for code changes alone', async () => {
    await renderModeChat({
      mode: 'auto', running: true, entries: [], over: { proposedChangeWorkpieces: [5] },
    })
    expect(buttonLabels()).not.toContain('Accept changes')
  })

  it('offers the accept mid-turn in Auto once a request needs review', async () => {
    await renderModeChat({ mode: 'auto', running: true, entries: [autoApprovable(), entry(2, { chatId: 1 })] })
    expect(buttonLabels()).toContain('Accept changes')
  })

  it('offers the accept in Auto once the turn has stopped with the chat forked', async () => {
    await renderModeChat({ mode: 'auto', running: false, entries: [autoApprovable()] })
    expect(buttonLabels()).toContain('Accept changes')
    expect(document.body.textContent).not.toContain('accepted when the agent finishes')
  })

  it.each(['review', 'fork'] as const)('offers the accept mid-turn in %s', async (mode) => {
    await renderModeChat({ mode, running: true, entries: [autoApprovable()] })
    expect(buttonLabels()).toContain('Accept changes')
  })
})

describe('requests that need review', () => {
  it.each(['auto', 'review', 'fork'] as const)('are marked in %s, on the row and the request', async (mode) => {
    await renderModeChat({
      mode, running: false,
      entries: [pendingLog({ autoApprovable: true }) as ActionLogEntry, entry(2, { chatId: 1 })],
    })
    // The connection's row says so while it is closed.
    expect(reviewLabels()).toBe(1)
    await openDisclosure('2 requests')
    // Its row, and the one request of the two that is not auto-approvable.
    expect(reviewLabels()).toBe(2)
  })

  it('are not a creation or a code change', async () => {
    await renderModeChat({
      mode: 'review', running: false,
      entries: [
        entry(1, { chatId: 1, creation: true }),
        entry(2, { chatId: 1, description: { title: 'Edit', description: '', implementsRevert: false, autoApprovable: true } }),
      ],
      over: { proposedChangeWorkpieces: [5] },
    })
    await openDisclosure('2 requests')
    expect(reviewLabels()).toBe(0)
  })
})

describe('code changes in the pending list', () => {
  it('lists each gadget and worktree the chat changes, each opening its code', async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [{
      id: 1, title: 'Chat', mode: 'auto', started: new Date(), lastActive: new Date(),
      // 7 is a gatekeeper whose binding the chat changes, which has no code to open.
      proposedChangeWorkpieces: [5, 6, 7],
    }])
    const onOpenWorkpieceCode = vi.fn<(workpieceId: number) => void>()
    await renderChat(server.overseer, {
      selectedChatId: 1, onOpenWorkpieceCode,
      workpieces: [
        { id: 5, type: 'gadget', title: 'Todo app' },
        { id: 6, type: 'worktree', title: 'Scratch', chatId: 1 },
      ] as WorkpieceSummary[],
    })
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [{ ...entry(1), chatId: 1 } as ActionLogEntry] })

    expect(document.body.textContent).toContain('2 code changes and 1 request waiting')
    const row = (title: string) => [...document.querySelectorAll('button')]
      .find(b => b.textContent?.trim() === title)
    expect(row('Scratch')).toBeDefined()
    await act(async () => row('Todo app')!.click())
    expect(onOpenWorkpieceCode).toHaveBeenCalledExactlyOnceWith(5)
  })
})

describe("a resource the agent created", () => {
  const accepted = { by: { type: 'user', id: 'alice', name: 'Alice' }, at: new Date(0), autoApproved: false }
  const creation = (over: Partial<Record<string, unknown>> = {}) => entry(1, {
    chatId: 1, creation: true, resourceTitle: 'Trip plan',
    description: { title: 'Create Google Doc: Trip plan', description: '', implementsRevert: false, autoApprovable: false },
    ...over,
  })

  async function renderCreation(log: ActionLogEntry) {
    // Read afresh for each test, under a session of its own.
    auth.authenticatedApi = {
      listGatekeeperVendors: async () => [{
        id: 'google', description: { displayName: 'Google', url: '' },
        supportedResources: [{ id: 'doc', title: 'Google Doc', urlPattern: 'https://docs.google.com/*' }],
      }],
    } as unknown as typeof auth.authenticatedApi
    const server = makeOverseer()
    const chat = withChatApi(server, undefined, [
      { id: 1, title: 'Chat', mode: 'auto', started: new Date(), lastActive: new Date() },
    ])
    await renderChat(server.overseer, { selectedChatId: 1 })
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: log.state === 'pending' ? [log] : [] })
    chat.emitMessage({
      chatId: 1, sequence: 0, timestamp: new Date(), author: agent, type: 'message', message: '',
      toolCalls: [{
        toolName: 'createExternalResource', id: 'call',
        input: { vendorId: 'google', resourceTypeId: 'doc', title: 'Trip plan', bindingName: 'trip' },
        output: { gatekeeperId: 1 },
      }],
    } as unknown as AiChatMessage)
    chat.emitMessage({ ...actionMessage, sequence: 1, actionLog: log } as AiChatMessage)
    await act(async () => {})
  }

  const saveButton = () => [...document.querySelectorAll('button')]
    .find(b => b.textContent?.trim() === 'Save to account')

  it('is unsaved, and can be saved once the chat is accepted', async () => {
    await renderCreation(creation())

    expect(document.body.textContent).toContain('Trip plan')
    expect(document.body.textContent).toContain('Google Doc · Google')
    expect(saveButton()?.disabled).toBe(true)
    expect(buttonLabels()).toContain('Discard')
  })

  it('offers saving once accepted', async () => {
    await renderCreation(creation({ accepted }))

    expect(saveButton()?.disabled).toBe(false)
  })

  it('links to the resource once saved', async () => {
    await renderCreation(creation({ state: 'approved', resourceUrl: 'https://docs.google.com/document/d/1' }))

    expect(document.body.textContent).toContain('Saved')
    expect(document.body.textContent).not.toContain('Unsaved')
    const link = [...document.querySelectorAll('a')].find(a => a.textContent?.includes('Trip plan'))
    expect(link?.getAttribute('href')).toBe('https://docs.google.com/document/d/1')
    expect(buttonLabels()).not.toContain('Save to account')
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
    const described = trayDenyDescribedBy()
    expect(described).toContain(RESTRICTED_APPROVAL_COPY)
    expect(described).toContain('Regards, the workspace.')
    expect(described).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it("shows what a save that did not finish left, with its error, Retry and Deny", async () => {
    const accepted = { by: { type: 'user', id: 'alice', name: 'Alice' }, at: new Date(0), autoApproved: false }
    const message = 'The provider refused the change. '.repeat(8)
    await renderPendingCard(entry(1, {
      chatId: 1, accepted, applyError: { message, retryable: true },
      description: { title: 'Add a paragraph', description: '', implementsRevert: false },
    }))

    expect(document.body.textContent).toContain('Save did not finish')
    const alerts = [...document.querySelectorAll('[role="alert"]')].map(alert => alert.textContent)
    expect(alerts).toContain(`Could not apply: ${message}`)
    const labels = [...document.querySelectorAll('button')].map(b => b.textContent)
    expect(labels).toContain('Retry')
    expect(labels).toContain('Deny')
  })

  it('offers no rule controls on a card, auto-approvable or not', async () => {
    await renderPendingCard(pendingLog({ autoApprovable: true, actionKind: { tag: 'send', label: 'Send' } }))
    await openTray()

    expect([...document.querySelectorAll('button')].some(b => b.textContent === 'Always approve'))
      .toBe(false)
  })

  it('names only the restricted notice and request for a complete description', async () => {
    await renderPendingCard(pendingLog({ descriptionIsComplete: true }), { restricted: true })
    await openTray()

    const described = trayDenyDescribedBy()
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

    expect(trayDenyDescribedBy()).toContain('a@example.com')
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

  it('says why a blocking request failed, and offers no Approve once it cannot be retried',
    async () => {
      const applyError = { message: 'Timed out.', retryable: false, outcomeUnknown: true as const }
      await renderPendingCard({ ...pendingLog({ awaitDecision: true }), applyError } as ActionLogEntry)

      const card = document.querySelector('[class*="border-kumo-brand/40"]')!
      expect(card.querySelector('[role="alert"]')?.textContent).toBe(
        'Could not apply: Timed out. It may have been applied anyway. Check the resource before you deny it.')
      expect([...card.querySelectorAll('button')].map(button => button.textContent)).toEqual(['Deny'])
    })

  it('summarises a tray request, and names nothing, when not restricted', async () => {
    await renderPendingCard(pendingLog())
    await openTray()

    expect(document.body.textContent).not.toContain(RESTRICTED_APPROVAL_COPY)
    // Clamped rather than scrolled: the tray shows a preview and opens the request for the rest.
    expect(document.querySelector('[class*="line-clamp-2"]')).not.toBeNull()
    expect(trayDenyDescribedBy()).toBeNull()
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

const openChat = { id: 1, title: 'Chat', mode: 'auto' as const, started: new Date(), lastActive: new Date() }

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

describe('the chat mode', () => {
  const modeShown = () => document.querySelector<HTMLElement>('[data-testid="mode"]')!
  const choose = async (mode: string) => {
    const button = [...modeShown().querySelectorAll('button')].find(b => b.textContent === `Mode ${mode}`)
    await act(async () => button!.click())
  }
  const signIn = () => {
    auth.currentUser = { id: 'alice' }
    auth.isCurrentUserConfirmed = true
  }

  beforeEach(() => {
    addToast.mockClear()
    localStorage.clear()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
  })
  afterEach(() => {
    auth.currentUser = null
    auth.isCurrentUserConfirmed = false
  })

  it("shows a follow-up the chat's mode, Auto when it has none", async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [
      { id: 1, title: 'Chat', started: new Date(), lastActive: new Date(), mode: 'review' },
      { id: 2, title: 'Other', mode: 'auto', started: new Date(), lastActive: new Date() },
    ])
    await renderChat(server.overseer, { selectedChatId: 1 })
    expect(modeShown().dataset.mode).toBe('review')

    await renderChat(server.overseer, { selectedChatId: 2 })
    expect(modeShown().dataset.mode).toBe('auto')
  })

  it("changes the chat's mode as soon as it is chosen, and puts it back if that fails", async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [{ id: 1, title: 'Chat', mode: 'auto', started: new Date(), lastActive: new Date() }])
    const change = deferred<void>()
    const setChatMode = vi.fn<Overseer['setChatMode']>(() => change.promise)
    Object.assign(server.overseer as object, { setChatMode })
    await renderChat(server.overseer, { selectedChatId: 1 })

    await choose('fork')
    expect(setChatMode).toHaveBeenCalledExactlyOnceWith(1, 'fork')
    expect(modeShown().dataset.mode).toBe('fork')

    await change.reject(new Error('Not permitted.'))
    expect(modeShown().dataset.mode).toBe('auto')
    expect(addToast).toHaveBeenCalledExactlyOnceWith(
      { title: 'Failed to change the mode', description: 'Not permitted.', variant: 'error' })
  })

  it('is read-only for a user who may not change it', async () => {
    const server = makeOverseer()
    withChatApi(server, undefined, [{ id: 1, title: 'Chat', mode: 'auto', started: new Date(), lastActive: new Date() }])
    await renderChat(server.overseer, { selectedChatId: 1, modeReadOnly: true })

    expect(modeShown().dataset.readonly).toBe('true')
  })

  it('starts a new chat in the mode the user last started one in, and remembers a new choice', async () => {
    signIn()
    localStorage.setItem('lastChatMode:alice', 'fork')
    const server = makeOverseer()
    withChatApi(server)
    const newChat = vi.fn<Overseer['newChat']>(async () => 4)
    Object.assign(server.overseer as object, { newChat })
    await renderChat(server.overseer)
    expect(modeShown().dataset.mode).toBe('fork')

    await sendFromComposer('Plan the trip')
    expect(newChat.mock.calls[0][2]).toBe('fork')

    await choose('review')
    await sendFromComposer('Plan another')
    expect(newChat.mock.calls[1][2]).toBe('review')
    expect(localStorage.getItem('lastChatMode:alice')).toBe('review')
  })

  it('starts a new chat in the default mode for a user who never chose', async () => {
    const server = makeOverseer()
    withChatApi(server)
    await renderChat(server.overseer)

    expect(modeShown().dataset.mode).toBe(DEFAULT_CHAT_MODE)
  })

  it('starts in Review where restricted data rules out Auto, leaving the remembered Auto alone', async () => {
    signIn()
    localStorage.setItem('lastChatMode:alice', 'auto')
    const server = makeOverseer()
    withChatApi(server)
    const newChat = vi.fn<Overseer['newChat']>(async () => 4)
    Object.assign(server.overseer as object, { newChat })
    await renderChat(server.overseer, { restricted: true })

    expect(modeShown().dataset.mode).toBe('review')
    expect(modeShown().dataset.restricted).toBe('true')
    await sendFromComposer('Plan the trip')
    expect(newChat.mock.calls[0][2]).toBe('review')
    expect(localStorage.getItem('lastChatMode:alice')).toBe('auto')
  })
})

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
