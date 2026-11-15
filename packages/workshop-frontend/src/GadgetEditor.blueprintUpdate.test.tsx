// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AiChatMetadata,
  WorkspaceMetadata,
  GadgetSummary,
  WorkpieceId,
  WorkpieceSummary,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'

// Covers which gadgets the editor offers "Update from blueprint" for, how the editor brings a
// chat into view (the one a blueprint update was proposed in, the one a notification opens, or
// the one a gadget's UI names), how a spawned agent's chat is shown over the chat the gadget pane
// follows,
// which gadget stub a use-only collaborator's view is given while gadgets are admitted, and which
// workspace a gadget's deletion is confirmed in.
// Everything the editor composes is stubbed down to the callbacks that drive its layout.

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

// The pane's tab strip watches its width once it holds more than one workpiece; jsdom has no
// ResizeObserver.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const PROPOSAL_CHAT_ID = 7

const GADGET: GadgetSummary = { id: 1, type: 'gadget', title: 'Itinerary', commitId: 'head' }

const mocks = vi.hoisted(() => {
  const disposable = { [Symbol.dispose]() {} }
  return {
    navigate: vi.fn<(options: {
      search: (prev: Record<string, unknown>) => unknown
      replace?: boolean
    }) => void>(),
    search: {} as Record<string, unknown>,
    workspaceId: 'workspace',
    // The editor's handler for its gadget UI's host.openAgentChat(), as last rendered.
    onOpenAgentChat: null as null | ((chatToken: string, signal: AbortSignal) => Promise<void>),
    // Reports the workspace's chats to the editor, as the chat pane does when its list changes.
    reportChats: null as null | ((chats: readonly AiChatMetadata[]) => void),
    // The workpieces the workspace's subscription delivers.
    workpieces: [] as WorkpieceSummary[],
    // What the chat pane, the code view, Connections and the gadget's UI were last rendered with.
    chatPane: null as null | {
      selectedChatId: number | null
      codeChatId?: number | null
      returnChatId?: number | null
      pendingConsoleLogCount: number
      onNavigateToChat: (chatId: number | null) => void
    },
    codeView: null as null | { selectedChatId?: number | null },
    connections: null as null | { chatId?: number },
    gadgetUi: null as null | { onConsoleLog?: (log: unknown) => void },
    // The props the use-only view was last rendered with.
    useView: null as null | {
      gadget: unknown
      gadgetOpenFailure: string | null
      onRetryGadget: () => void
    },
    workspace: {
      overseer: {
        stub: {
          subscribeToWorkpieces: async (subscriber: WorkpiecesSubscriber) => {
            await subscriber.entry(GADGET)
            for (const workpiece of mocks.workpieces) await subscriber.entry(workpiece)
            await subscriber.ready()
            return disposable
          },
          getGadget: () => disposable,
          listHooks: async () => [],
          subscribeToConsoleLogs: async () => disposable,
        },
      },
      metadata: { id: 'workspace', title: 'Trips', role: 'build' } as unknown as WorkspaceMetadata,
      error: null,
      connectionLost: false,
      observerConfig: null,
      createObserverConfigCallback: () => disposable,
      retry: () => {},
      cancelObserverConfig: () => {},
      updateTitle: () => {},
    },
    authenticatedApi: {
      whoami: async () => ({ type: 'user', id: 'dev', name: 'Dev' }),
      listWorkspaces: async () => [],
    },
  }
})

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: mocks.workspaceId }),
  useNavigate: () => mocks.navigate,
  useSearch: () => mocks.search,
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))

vi.mock('@cloudflare/kumo', () => {
  const DropdownMenu = Object.assign(
    ({ children }: { children: ReactNode }) => <div>{children}</div>,
    {
      Trigger: ({ render }: { render: ReactElement }) => render,
      Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
      Item: ({ children, onClick, disabled }: {
        children: ReactNode
        onClick?: () => void
        disabled?: boolean
      }) => <button type="button" role="menuitem" onClick={onClick} disabled={disabled}>{children}</button>,
      Separator: () => <hr />,
    },
  )
  return { DropdownMenu, useKumoToastManager: () => ({ add: () => {} }) }
})

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.authenticatedApi }),
}))
vi.mock('./RpcContext', () => ({ useConnectionLost: () => false, useRpcStub: () => ({}) }))
vi.mock('./useWorkspaceOpen', () => ({
  useWorkspaceOpen: () => mocks.workspace,
  observerOpenFailureMessage: () => null,
}))
vi.mock('./useActions', () => ({ useActions: () => ({ pending: [] }), useActionEntries: () => {} }))
vi.mock('./errorReporting', () => ({ reportIssue: () => {} }))
vi.mock('./features/blueprint-updates/useBlueprintUpdateAvailable', () => ({
  useBlueprintUpdateAvailable: () => false,
}))

// The two children whose reports decide when the editor's layout is ready.
vi.mock('./ChatInterface', () => ({
  default: ({ onChatCountChange, onChatListChange, ...props }: NonNullable<typeof mocks.chatPane> & {
    onChatCountChange: (count: number, hasChatZero: boolean) => void
    onChatListChange: (chats: readonly AiChatMetadata[]) => void
  }) => {
    useEffect(() => { onChatCountChange(0, false) }, [onChatCountChange])
    mocks.reportChats = onChatListChange
    mocks.chatPane = props
    return <div>chat pane</div>
  },
}))
vi.mock('./features/code/WorkpieceCodeInterface', () => ({
  default: ({ onHasCodeChange, selectedChatId }: {
    onHasCodeChange: (hasCode: boolean) => void
    selectedChatId?: number | null
  }) => {
    useEffect(() => { onHasCodeChange(true) }, [onHasCodeChange])
    mocks.codeView = { selectedChatId }
    return null
  },
}))

vi.mock('./features/blueprint-updates/UpdateFromBlueprintDialog', () => ({
  UpdateFromBlueprintDialog: ({ onProposed }: { onProposed: (chatId: number) => void }) => (
    <button type="button" onClick={() => onProposed(PROPOSAL_CHAT_ID)}>propose update</button>
  ),
}))

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, danger: _danger, ...props }: ComponentProps<'button'> & { danger?: boolean }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopInput: (props: ComponentProps<'input'>) => <input {...props} />,
}))

vi.mock('./WorkpiecePicker', () => ({
  default: () => null,
  WORKPIECE_RAIL_COLLAPSED_WIDTH: 48,
  WORKPIECE_RAIL_EXPANDED_WIDTH: 220,
}))
vi.mock('./components/format/FormatVisuals', () => ({ FormatGlyph: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./Activity', () => ({ default: () => null }))
vi.mock('./ActivityNotifications', () => ({ default: () => null }))
vi.mock('./BlueprintModal', () => ({ default: () => null }))
vi.mock('./Connections', () => ({
  default: ({ chatId }: { chatId?: number }) => {
    mocks.connections = { chatId }
    return null
  },
}))
vi.mock('./GadgetExportMenu', () => ({ default: () => null }))
vi.mock('./GadgetUI', () => ({
  default: ({ onOpenAgentChat, onConsoleLog }: {
    onOpenAgentChat?: typeof mocks.onOpenAgentChat
    onConsoleLog?: (log: unknown) => void
  }) => {
    mocks.onOpenAgentChat = onOpenAgentChat ?? null
    mocks.gadgetUi = { onConsoleLog }
    return null
  },
}))
vi.mock('./GadgetUseView', () => ({
  default: (props: NonNullable<typeof mocks.useView>) => {
    mocks.useView = props
    return null
  },
}))
vi.mock('./ObserverConfigModal', () => ({ default: () => null }))
vi.mock('./ShareModal', () => ({ default: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))
vi.mock('./components/DeleteConfirmationDialog', () => ({ default: () => null }))
vi.mock('./components/ReconnectingChip', () => ({ default: () => null }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./components/WorkspaceOpenErrorPage', () => ({ default: () => null }))
vi.mock('./features/notifications/WorkspaceNotificationsMenu', () => ({ WorkspaceNotificationsMenu: () => null }))
// A gadget's tab with its menu's Delete beside it, and the confirmation as one button.
vi.mock('./features/gadget-deletion/GadgetContextMenu', () => ({
  GadgetContextMenu: ({ trigger, onDelete }: { trigger: ReactElement<{ title: string }>; onDelete: () => void }) => (
    <>
      {trigger}
      <button type="button" onClick={onDelete}>delete {trigger.props.title}</button>
    </>
  ),
}))
vi.mock('./features/gadget-deletion/DeleteGadgetDialog', () => ({
  DeleteGadgetDialog: ({ gadget, onDelete }: {
    gadget: GadgetSummary
    onDelete: (id: WorkpieceId) => Promise<boolean>
  }) => <button type="button" onClick={() => void onDelete(gadget.id)}>confirm deleting {gadget.title}</button>,
}))

import GadgetEditor from './GadgetEditor'
import { isChatVisible } from './features/notifications/visibleChat'

let container: HTMLDivElement
let root: Root
const previousMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia')

/** Renders the editor on a screen of the given kind, with the gadget's pane open. */
async function openEditor(screen: 'phone' | 'desktop') {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: screen === 'phone' && query === '(width < 48rem)' }),
  })
  await act(async () => { root.render(<GadgetEditor />) })
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')]
    .find(candidate => candidate.textContent === name)
  if (!found) throw new Error(`No "${name}" button in: ${container.textContent}`)
  return found
}

const hasButton = (name: string) =>
  [...container.querySelectorAll('button')].some(candidate => candidate.textContent === name)

async function click(name: string) {
  await act(async () => { button(name).click() })
}

/** Which of the phone layout's views is showing: the chat, or what the pane holds. */
const currentView = () =>
  ['Chat', 'Preview', 'Activity'].filter(name => button(name).getAttribute('aria-current') === 'page')

async function proposeUpdate() {
  await click('Update from blueprint…')
  await click('propose update')
}

beforeEach(() => {
  mocks.onOpenAgentChat = null
  mocks.reportChats = null
  mocks.workpieces = []
  mocks.chatPane = null
  mocks.codeView = null
  mocks.connections = null
  mocks.gadgetUi = null
  mocks.navigate.mockReset()
  mocks.search = {}
  mocks.workspaceId = 'workspace'
  localStorage.clear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete GADGET.upstream
  if (previousMatchMedia) Object.defineProperty(window, 'matchMedia', previousMatchMedia)
  else Reflect.deleteProperty(window, 'matchMedia')
})

describe('GadgetEditor, offering an update from a blueprint', () => {
  const offers = () => [...container.querySelectorAll('button')]
    .filter(candidate => candidate.textContent === 'Update from blueprint…').length

  // Once in the toolbar's Blueprints menu and once in the phone layout's menu.
  it('offers it for a gadget that follows a blueprint, and for one of unknown origin', async () => {
    await openEditor('desktop')
    expect(offers()).toBe(2)

    act(() => root.unmount())
    root = createRoot(container)
    GADGET.upstream = { blueprintId: 'trip' }
    await openEditor('desktop')
    expect(offers()).toBe(2)
  })

  it('does not offer it for a gadget recorded as built from scratch', async () => {
    GADGET.upstream = {}

    await openEditor('desktop')

    expect(offers()).toBe(0)
    expect(button('Publish as blueprint…')).toBeTruthy()
  })
})

describe('GadgetEditor, once a blueprint update is proposed', () => {
  it('selects the chat that holds the proposal', async () => {
    await openEditor('desktop')
    await proposeUpdate()

    expect(mocks.navigate).toHaveBeenCalledTimes(1)
    expect(mocks.navigate.mock.calls[0][0].search({ w: 1 }))
      .toEqual({ w: 1, chat: PROPOSAL_CHAT_ID })
    expect(container.textContent).not.toContain('propose update')
  })

  // A phone shows the chat or the pane, never both, so selecting the chat does not show it.
  it('shows that chat on a phone, in place of the gadget it was applied from', async () => {
    await openEditor('phone')
    expect(currentView()).toEqual(['Preview'])

    await proposeUpdate()

    expect(currentView()).toEqual(['Chat'])
  })

  it('shows that chat on a phone, in place of the Activity pane', async () => {
    await openEditor('phone')
    await click('Activity')
    expect(currentView()).toEqual(['Activity'])

    await proposeUpdate()

    expect(currentView()).toEqual(['Chat'])
  })

  // Side by side with the chat, the pane is where the proposal is previewed.
  it('leaves the gadget pane open on a wider screen', async () => {
    await openEditor('desktop')
    expect(currentView()).toEqual(['Preview'])

    await proposeUpdate()

    expect(currentView()).toEqual(['Preview'])
  })
})

// A notification's "Open task" arrives as ?showChat.
describe('GadgetEditor, opening a chat from a notification', () => {
  it.each([
    { screen: 'phone', view: 'Chat' },
    { screen: 'desktop', view: 'Preview' },
  ] as const)('shows the chat on a $screen, then drops the request', async ({ screen, view }) => {
    mocks.search = { chat: 3, showChat: true }

    await openEditor(screen)

    expect(currentView()).toEqual([view])
    const [{ search, replace }] = mocks.navigate.mock.calls.at(-1)!
    expect(replace).toBe(true)
    expect(search(mocks.search)).toEqual({ chat: 3, showChat: undefined })
  })

  it('leaves full-screen preview, which would cover the chat', async () => {
    window.history.replaceState(null, '', '#fullscreen')
    await openEditor('desktop')
    const fullScreen = () => container.querySelector('[aria-label="Gadget full screen"]')
    expect(fullScreen()).not.toBeNull()

    // The router drops the hash with history.pushState, which fires no hashchange.
    window.history.replaceState(null, '', window.location.pathname)
    mocks.search = { chat: 3, showChat: true }
    await openEditor('desktop')

    expect(fullScreen()).toBeNull()
  })

  // Notifications skip only the chat the user can see.
  it('reports its chat visible only when nothing covers it', async () => {
    mocks.search = { chat: 3 }
    await openEditor('phone')
    expect(isChatVisible('workspace', 3)).toBe(false)
    await click('Chat')
    expect(isChatVisible('workspace', 3)).toBe(true)

    act(() => root.unmount())
    root = createRoot(container)
    await openEditor('desktop')
    expect(isChatVisible('workspace', 3)).toBe(true)

    act(() => root.unmount())
    expect(isChatVisible('workspace', 3)).toBe(false)
    root = createRoot(container)
    window.history.replaceState(null, '', '#fullscreen')
    await openEditor('desktop')
    expect(isChatVisible('workspace', 3)).toBe(false)
    window.history.replaceState(null, '', window.location.pathname)
  })

  it('withdraws the visible chat in the conversation list and restores it on return', async () => {
    mocks.search = { chat: 3 }
    await openEditor('desktop')
    expect(isChatVisible('workspace', 3)).toBe(true)

    mocks.search = {}
    await openEditor('desktop')
    expect(isChatVisible('workspace', 3)).toBe(false)

    mocks.search = { chat: 3 }
    await openEditor('desktop')
    expect(isChatVisible('workspace', 3)).toBe(true)
  })
})

/** A chat's metadata, as the chat pane lists it. */
function chatMeta(id: number, extra: Partial<AiChatMetadata> = {}): AiChatMetadata {
  return { id, title: `Chat ${id}`, started: new Date(0), lastActive: new Date(0), ...extra }
}

/** A spawned agent's chat, which a gadget names by its token. */
const spawnedChat = (id: number, chatToken = `tok-${id}`) =>
  chatMeta(id, { spawnerName: 'Researcher', spawnerId: 4, chatToken })

async function reportChats(...chats: AiChatMetadata[]) {
  await act(async () => { mocks.reportChats!(chats) })
}

// A gadget's UI names a chat it spawned by its token (GadgetHost.openAgentChat).
describe('GadgetEditor, opening a chat a gadget names', () => {
  const navigatedChats = () => mocks.navigate.mock.calls
    .map(([{ search }]) => (search({}) as { agent?: number }).agent)
    .filter(chat => chat !== undefined)

  async function openAgentChat(chatToken: string, signal = new AbortController().signal) {
    if (!mocks.onOpenAgentChat) throw new Error('The gadget UI has no openAgentChat handler')
    await act(async () => { await mocks.onOpenAgentChat!(chatToken, signal) })
  }

  async function reportChatTokens(chatIdsByToken: Record<string, number>) {
    await reportChats(...Object.entries(chatIdsByToken).map(([token, id]) => spawnedChat(id, token)))
  }

  it.each([
    { screen: 'phone', view: 'Chat' },
    { screen: 'desktop', view: 'Preview' },
  ] as const)('selects the chat and shows it on a $screen', async ({ screen, view }) => {
    await openEditor(screen)
    await reportChatTokens({ 'tok-a': 5 })

    await openAgentChat('tok-a')

    expect(navigatedChats()).toEqual([5])
    expect(currentView()).toEqual([view])
  })

  it('waits for a chat whose metadata arrives after the request', async () => {
    await openEditor('desktop')
    await reportChatTokens({})
    let opened = false
    const request = mocks.onOpenAgentChat!('tok-a', new AbortController().signal)
      .then(() => { opened = true })
    await act(async () => {})
    expect(opened).toBe(false)

    await reportChatTokens({ 'tok-a': 5 })
    await act(async () => { await request })

    expect(navigatedChats()).toEqual([5])
  })

  it('does nothing while the gadget is hidden behind Activity', async () => {
    await openEditor('phone')
    await reportChatTokens({ 'tok-a': 5 })
    await click('Activity')

    await openAgentChat('tok-a')

    expect(navigatedChats()).toEqual([])
    expect(currentView()).toEqual(['Activity'])
  })

  it('drops a request whose gadget is hidden before its chat arrives', async () => {
    await openEditor('phone')
    await reportChatTokens({})
    const request = mocks.onOpenAgentChat!('tok-a', new AbortController().signal)
    await click('Activity')

    await reportChatTokens({ 'tok-a': 5 })
    await act(async () => { await request })

    expect(navigatedChats()).toEqual([])
    expect(currentView()).toEqual(['Activity'])
  })

  it("drops a request whose frame's session ends just as its chat is found", async () => {
    await openEditor('desktop')
    await reportChatTokens({ 'tok-a': 5 })
    const abort = new AbortController()
    const request = mocks.onOpenAgentChat!('tok-a', abort.signal)
    abort.abort()
    await act(async () => { await request })

    expect(navigatedChats()).toEqual([])
  })

  it("drops a request whose frame's session ends before its chat arrives", async () => {
    await openEditor('desktop')
    await reportChatTokens({})
    const abort = new AbortController()
    const request = mocks.onOpenAgentChat!('tok-a', abort.signal)
    abort.abort()

    await reportChatTokens({ 'tok-a': 5 })
    await act(async () => { await request })

    expect(navigatedChats()).toEqual([])
  })
})

// A spawned agent's chat opens over the chat the user works in, whose gadget pane stays as it was:
// a draft under test stays in it, and nothing done there is filed under the agent.
describe("GadgetEditor, showing a spawned agent's chat over the working chat", () => {
  const WORKING_CHAT = 2
  const AGENT_CHAT = 5
  const DRAFT: GadgetSummary = { id: 3, type: 'gadget', title: 'Draft', chatId: WORKING_CHAT }
  const AGENT_WORKTREE: WorkpieceSummary = {
    id: 6, type: 'worktree', title: 'Notes', chatId: AGENT_CHAT,
    pinBase: 'c', headCommit: 'c', baseCommit: 'c',
  }

  async function openWith(search: Record<string, unknown>, ...workpieces: WorkpieceSummary[]) {
    mocks.search = search
    mocks.workpieces = workpieces
    await openEditor('desktop')
    await reportChats(chatMeta(WORKING_CHAT), chatMeta(8), spawnedChat(AGENT_CHAT))
  }

  /** Where the editor's last navigation goes from the current URL. */
  const lastNavigation = () => mocks.navigate.mock.calls.at(-1)![0].search(mocks.search)

  it.each([
    {
      from: 'the gadget',
      open: async () => {
        await act(async () => {
          await mocks.onOpenAgentChat!(`tok-${AGENT_CHAT}`, new AbortController().signal)
        })
      },
    },
    {
      from: 'the chat pane',
      open: async () => { await act(async () => { mocks.chatPane!.onNavigateToChat(AGENT_CHAT) }) },
    },
  ])('opens from $from over the working chat, keeping its draft selected', async ({ open }) => {
    await openWith({ chat: WORKING_CHAT, w: DRAFT.id }, DRAFT)

    await open()

    expect(lastNavigation()).toEqual({ chat: WORKING_CHAT, agent: AGENT_CHAT, w: DRAFT.id })
  })

  it('shows the agent in the chat pane while the gadget pane follows the working chat',
      async () => {
    await openWith({ chat: WORKING_CHAT, agent: AGENT_CHAT, w: DRAFT.id }, DRAFT)

    expect(mocks.chatPane).toMatchObject({
      selectedChatId: AGENT_CHAT, codeChatId: WORKING_CHAT, returnChatId: WORKING_CHAT,
    })
    expect(mocks.codeView).toEqual({ selectedChatId: WORKING_CHAT })
    expect(mocks.connections).toEqual({ chatId: WORKING_CHAT })
    expect(mocks.navigate.mock.calls
      .map(([{ search }]) => search(mocks.search) as { chat?: number; agent?: number })
      .filter(next => next.chat !== WORKING_CHAT || next.agent !== AGENT_CHAT)).toEqual([])
  })

  // A worktree is the one workpiece a spawned agent's chat can own, and it is that chat's.
  it("works in the agent's chat while one of its worktrees is selected", async () => {
    await openWith({ chat: WORKING_CHAT, agent: AGENT_CHAT, w: AGENT_WORKTREE.id }, AGENT_WORKTREE)

    expect(mocks.chatPane).toMatchObject({ selectedChatId: AGENT_CHAT, codeChatId: AGENT_CHAT })
    expect(mocks.codeView).toEqual({ selectedChatId: AGENT_CHAT })
  })

  it('returns to the working chat on Back, leaving behind only what was the agent\'s',
      async () => {
    await openWith({ chat: WORKING_CHAT, agent: AGENT_CHAT, w: DRAFT.id }, DRAFT)
    await act(async () => { mocks.chatPane!.onNavigateToChat(null) })
    expect(lastNavigation()).toEqual({ chat: WORKING_CHAT, agent: undefined, w: DRAFT.id })

    act(() => root.unmount())
    root = createRoot(container)
    await openWith(
      { chat: WORKING_CHAT, agent: AGENT_CHAT, w: AGENT_WORKTREE.id }, DRAFT, AGENT_WORKTREE)
    await act(async () => { mocks.chatPane!.onNavigateToChat(null) })
    expect(lastNavigation()).toEqual({ chat: WORKING_CHAT, agent: undefined, w: undefined })
  })

  it("keeps the agent's chat over the working chat when its worktree is picked", async () => {
    await openWith({ chat: WORKING_CHAT, agent: AGENT_CHAT, w: DRAFT.id }, DRAFT, AGENT_WORKTREE)

    await act(async () => { container.querySelector<HTMLButtonElement>('button[title="Notes"]')!.click() })

    expect(lastNavigation()).toEqual({ chat: WORKING_CHAT, agent: AGENT_CHAT, w: AGENT_WORKTREE.id })
  })

  it('closes the agent\'s chat when another conversation opens', async () => {
    await openWith({ chat: WORKING_CHAT, agent: AGENT_CHAT })

    await act(async () => { mocks.chatPane!.onNavigateToChat(8) })

    expect(lastNavigation()).toEqual({ chat: 8, agent: undefined, w: undefined })
  })

  it.each([
    { name: "a spawned agent's chat named as the working chat", search: { chat: AGENT_CHAT },
      fixed: { chat: undefined, agent: AGENT_CHAT } },
    { name: 'another chat named as the agent', search: { chat: WORKING_CHAT, agent: 8 },
      fixed: { chat: 8, agent: undefined } },
    { name: 'an agent naming no chat', search: { chat: WORKING_CHAT, agent: 9 },
      fixed: { chat: WORKING_CHAT, agent: undefined } },
    { name: 'a working chat deleted under the agent', search: { chat: 9, agent: AGENT_CHAT },
      fixed: { chat: undefined, agent: AGENT_CHAT } },
  ])('corrects the URL for $name', async ({ search, fixed }) => {
    await openWith(search)

    const [{ search: next, replace }] = mocks.navigate.mock.calls.at(-1)!
    expect(replace).toBe(true)
    expect(next(search)).toEqual(fixed)
  })

  it("holds the gadget's console logs back from the agent's chat", async () => {
    await openWith({ chat: WORKING_CHAT })
    await act(async () => {
      mocks.gadgetUi!.onConsoleLog!({ timestamp: new Date(0), level: 'log', message: ['hi'] })
    })
    expect(mocks.chatPane!.pendingConsoleLogCount).toBe(1)

    mocks.search = { chat: WORKING_CHAT, agent: AGENT_CHAT }
    await openEditor('desktop')
    expect(mocks.chatPane!.pendingConsoleLogCount).toBe(0)

    mocks.search = { chat: WORKING_CHAT }
    await openEditor('desktop')
    expect(mocks.chatPane!.pendingConsoleLogCount).toBe(1)
  })
})

// A use-only collaborator is verified as each gadget opens, so the view gets a gadget's stub only
// once its admission resolves, and never one disposed when an earlier admission was abandoned.
describe('GadgetEditor, admitting a use-only collaborator to gadgets', () => {
  const BUDGET: GadgetSummary = { id: 2, type: 'gadget', title: 'Budget', commitId: 'head' }
  type Client = { gadgetId: WorkpieceId; disposed: boolean }
  const workspace = mocks.workspace
  const original = { overseer: workspace.overseer, metadata: workspace.metadata }
  let admissions: { resolve: () => void; reject: (error: Error) => void }[]
  const shownClient = () => mocks.useView?.gadget as Client | null | undefined

  // A fresh overseer stub, as a reconnect hands the editor.
  function useOnlyOverseer(): typeof original.overseer {
    const disposable = { [Symbol.dispose]() {} }
    return {
      stub: {
        ...original.overseer.stub,
        subscribeToWorkpieces: async (subscriber: WorkpiecesSubscriber) => {
          await subscriber.entry(GADGET)
          await subscriber.entry(BUDGET)
          await subscriber.ready()
          return disposable
        },
        getGadget: (gadgetId?: WorkpieceId) => {
          const { promise, resolve, reject } = Promise.withResolvers<unknown>()
          const client = {
            gadgetId: gadgetId!,
            disposed: false,
            [Symbol.dispose]() { client.disposed = true },
          }
          admissions.push({ resolve: () => resolve({ dup: () => client, [Symbol.dispose]() {} }), reject })
          return Object.assign(promise, disposable)
        },
      },
    }
  }

  beforeEach(() => {
    admissions = []
    mocks.useView = null
    workspace.metadata = { ...original.metadata, role: 'use' } as WorkspaceMetadata
    workspace.overseer = useOnlyOverseer()
  })

  afterEach(() => {
    workspace.overseer = original.overseer
    workspace.metadata = original.metadata
  })

  it('shows nothing while a gadget it left is admitted again', async () => {
    mocks.search = { w: GADGET.id }
    await openEditor('desktop')
    await act(async () => admissions.at(-1)!.resolve())
    const first = shownClient()
    expect(first).toMatchObject({ gadgetId: GADGET.id, disposed: false })

    // Leave for a gadget still being admitted, and come back before it is.
    mocks.search = { w: BUDGET.id }
    await openEditor('desktop')
    mocks.search = { w: GADGET.id }
    await openEditor('desktop')

    expect(first?.disposed).toBe(true)
    expect(shownClient()).toBeNull()
    await act(async () => admissions.at(-1)!.resolve())
    expect(shownClient()).toMatchObject({ gadgetId: GADGET.id, disposed: false })
  })

  it('keeps the gadget on screen through a reconnect, but not past a refused re-admission', async () => {
    mocks.search = { w: GADGET.id }
    await openEditor('desktop')
    await act(async () => admissions.at(-1)!.resolve())
    const first = shownClient()

    workspace.overseer = useOnlyOverseer()
    await openEditor('desktop')
    expect(shownClient()).toBe(first)

    await act(async () => admissions.at(-1)!.reject(new Error('refused')))
    expect(mocks.useView?.gadgetOpenFailure).not.toBeNull()

    await act(async () => mocks.useView!.onRetryGadget())
    expect(mocks.useView?.gadgetOpenFailure).toBeNull()
    expect(shownClient()).toBeNull()
  })
})

describe('GadgetEditor, deleting a gadget', () => {
  const workspace = mocks.workspace
  const original = workspace.overseer
  let removed: string[]

  // Workspaces number their gadgets alike, from 1, so these share ids.
  function overseerFor(workspaceId: string, titles: string[]): typeof original {
    const disposable = { [Symbol.dispose]() {} }
    return {
      stub: {
        ...original.stub,
        subscribeToWorkpieces: async (subscriber: WorkpiecesSubscriber) => {
          for (const [index, title] of titles.entries()) {
            await subscriber.entry({ id: index + 1, type: 'gadget', title, commitId: 'head' })
          }
          await subscriber.ready()
          return disposable
        },
        getGadget: (gadgetId?: WorkpieceId) => ({
          remove: async () => { removed.push(`${workspaceId}:${gadgetId}`) },
          ...disposable,
        }),
      },
    }
  }

  async function openWorkspace(workspaceId: string, titles: string[]) {
    mocks.workspaceId = workspaceId
    workspace.overseer = overseerFor(workspaceId, titles)
    await openEditor('desktop')
  }

  beforeEach(() => {
    removed = []
    mocks.search = { w: 1 }
    // The tab strip watches its own width.
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  })

  afterEach(() => {
    workspace.overseer = original
    vi.unstubAllGlobals()
  })

  it('deletes the gadget once confirmed', async () => {
    await openWorkspace('trips', ['Itinerary', 'Packing'])

    await click('delete Packing')
    expect(removed).toEqual([])
    await click('confirm deleting Packing')

    expect(removed).toEqual(['trips:2'])
  })

  // The pane names a lone gadget rather than tabbing it.
  it('offers the menu on the open gadget when it is the only one', async () => {
    await openWorkspace('trips', ['Itinerary'])

    // The keyboard's menu key opens the menu of whatever has focus.
    const name = container.querySelector<HTMLElement>('[title="Itinerary"]')!
    act(() => name.focus())
    expect(document.activeElement).toBe(name)

    await click('delete Itinerary')
    await click('confirm deleting Itinerary')

    expect(removed).toEqual(['trips:1'])
  })

  // Back, or a notification's "Open task", moves the editor to another workspace without
  // remounting it.
  it('drops a confirmation when the editor moves to another workspace', async () => {
    await openWorkspace('trips', ['Itinerary', 'Packing'])
    await click('delete Packing')

    await openWorkspace('budget', ['Expenses', 'Invoices'])
    expect(hasButton('confirm deleting Packing')).toBe(false)

    await openWorkspace('trips', ['Itinerary', 'Packing'])
    expect(hasButton('confirm deleting Packing')).toBe(false)
    expect(removed).toEqual([])
  })
})
