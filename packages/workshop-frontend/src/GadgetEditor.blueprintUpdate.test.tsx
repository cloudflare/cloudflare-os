// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkspaceMetadata,
  GadgetSummary,
  WorkpieceId,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'

// Covers which gadgets the editor offers "Update from blueprint" for, how the editor brings a
// chat into view (the one a blueprint update was proposed in, or the one a notification opens),
// which gadget stub a use-only collaborator's view is given while gadgets are admitted or viewed
// as snapshots, and which workspace a gadget's deletion is confirmed in.
// Everything the editor composes is stubbed down to the callbacks that drive its layout.

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

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
    // The props the use-only view was last rendered with.
    useView: null as null | {
      gadget: unknown
      snapshot: {
        refreshedAt: Date
        onRefresh: () => Promise<void>
        onVerify: () => void
        verifying: boolean
      } | null
      gadgetOpenFailure: string | null
      onRetryGadget: () => void
    },
    // The props the account prompt was last rendered with.
    observerModal: null as null | { subject: 'workspace' | 'gadget'; onViewSnapshot?: () => void },
    workspace: {
      overseer: {
        stub: {
          subscribeToWorkpieces: async (subscriber: WorkpiecesSubscriber) => {
            await subscriber.entry(GADGET)
            await subscriber.ready()
            return disposable
          },
          getGadget: () => disposable,
          gadgetRequiresAccounts: async () => false,
          getGadgetSnapshot: () => disposable,
          listHooks: async () => [],
          subscribeToConsoleLogs: async () => disposable,
        },
      },
      metadata: { id: 'workspace', title: 'Trips', role: 'build' } as unknown as WorkspaceMetadata,
      error: null,
      connectionLost: false,
      observerConfig: null as null | {
        needs: unknown[]
        gadget?: { id: WorkpieceId; offersSnapshot: boolean }
        resolve: () => void
        reject: () => void
      },
      createObserverConfigCallback:
        vi.fn<(signal: AbortSignal, gadget?: { id: WorkpieceId; offersSnapshot: boolean }) => typeof disposable>(
          () => disposable),
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
  isObserverConfigCancelled: (caught: unknown) => caught instanceof Error && caught.message === 'cancelled',
}))
vi.mock('./useActions', () => ({ useActions: () => ({ pending: [] }), useActionEntries: () => {} }))
vi.mock('./errorReporting', () => ({ reportIssue: () => {} }))
vi.mock('./features/blueprint-updates/useBlueprintUpdateAvailable', () => ({
  useBlueprintUpdateAvailable: () => false,
}))

// The two children whose reports decide when the editor's layout is ready.
vi.mock('./ChatInterface', () => ({
  default: ({ onChatCountChange }: { onChatCountChange: (count: number, hasChatZero: boolean) => void }) => {
    useEffect(() => { onChatCountChange(0, false) }, [onChatCountChange])
    return <div>chat pane</div>
  },
}))
vi.mock('./features/code/WorkpieceCodeInterface', () => ({
  default: ({ onHasCodeChange }: { onHasCodeChange: (hasCode: boolean) => void }) => {
    useEffect(() => { onHasCodeChange(true) }, [onHasCodeChange])
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
vi.mock('./Connections', () => ({ default: () => null }))
vi.mock('./GadgetExportMenu', () => ({ default: () => null }))
vi.mock('./GadgetUI', () => ({ default: () => null }))
vi.mock('./GadgetUseView', () => ({
  default: (props: NonNullable<typeof mocks.useView>) => {
    mocks.useView = props
    return null
  },
}))
vi.mock('./ObserverConfigModal', () => ({
  default: (props: NonNullable<typeof mocks.observerModal>) => {
    mocks.observerModal = props
    return null
  },
}))
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

// A use-only collaborator is verified as each gadget opens, so the view gets a gadget's stub only
// once its admission resolves, and never one disposed when an earlier admission was abandoned.
describe('GadgetEditor, admitting a use-only collaborator to gadgets', () => {
  const BUDGET: GadgetSummary = { id: 2, type: 'gadget', title: 'Budget', commitId: 'head' }
  type Client = { gadgetId: WorkpieceId; disposed: boolean }
  const workspace = mocks.workspace
  const original = { overseer: workspace.overseer, metadata: workspace.metadata }
  let admissions: { resolve: () => void; reject: (error: Error) => void }[]
  let snapshots: { gadgetId: WorkpieceId; resolve: () => void; client: SnapshotClient }[]
  // The gadgets that reach a connection requiring an account (Overseer.gadgetRequiresAccounts).
  let requiringAccounts: ReadonlySet<WorkpieceId>
  type SnapshotClient = Client & Disposable & { refresh: () => Promise<Date> }
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
        gadgetRequiresAccounts: async (gadgetId?: WorkpieceId) => requiringAccounts.has(gadgetId!),
        getGadgetSnapshot: (gadgetId?: WorkpieceId) => {
          const { promise, resolve } = Promise.withResolvers<unknown>()
          const client: SnapshotClient = {
            gadgetId: gadgetId!,
            disposed: false,
            refresh: async () => new Date(2000),
            [Symbol.dispose]() { client.disposed = true },
          }
          snapshots.push({ gadgetId: gadgetId!, client, resolve: () => resolve({ dup: () => client, [Symbol.dispose]() {} }) })
          return Object.assign(promise, disposable, { getRefreshedAt: async () => new Date(1000) })
        },
      },
    }
  }

  beforeEach(() => {
    admissions = []
    snapshots = []
    requiringAccounts = new Set()
    mocks.useView = null
    mocks.observerModal = null
    workspace.metadata = { ...original.metadata, role: 'use' } as WorkspaceMetadata
    workspace.overseer = useOnlyOverseer()
  })

  afterEach(() => {
    workspace.overseer = original.overseer
    workspace.metadata = original.metadata
    workspace.observerConfig = null
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

  it('views a gadget as a snapshot once chosen from its account prompt, and only that gadget', async () => {
    const prompt = { needs: [], resolve: () => {}, reject: () => {} }
    // A workspace's prompt offers no snapshot: there is no gadget to take one of.
    workspace.observerConfig = prompt
    mocks.search = { w: GADGET.id }
    await openEditor('desktop')
    expect(mocks.observerModal?.onViewSnapshot).toBeUndefined()

    workspace.observerConfig = { ...prompt, gadget: { id: GADGET.id, offersSnapshot: true } }
    await openEditor('desktop')
    await act(async () => mocks.observerModal!.onViewSnapshot!())
    expect(mocks.observerModal?.subject).toBe('gadget')
    workspace.observerConfig = null
    expect(snapshots.map(s => s.gadgetId)).toEqual([GADGET.id])
    expect(shownClient()).toBeNull()

    await act(async () => snapshots[0].resolve())
    expect(shownClient()).toBe(snapshots[0].client)
    expect(mocks.useView?.snapshot?.refreshedAt).toEqual(new Date(1000))
    await act(() => mocks.useView!.snapshot!.onRefresh())
    expect(mocks.useView?.snapshot?.refreshedAt).toEqual(new Date(2000))
    expect(shownClient()).toBe(snapshots[0].client)

    // Another gadget is admitted live; returning reopens a snapshot rather than a live gadget.
    const admitted = admissions.length
    mocks.search = { w: BUDGET.id }
    await openEditor('desktop')
    expect(snapshots[0].client.disposed).toBe(true)
    expect(admissions).toHaveLength(admitted + 1)
    await act(async () => admissions.at(-1)!.resolve())
    expect(mocks.useView?.snapshot).toBeNull()

    mocks.search = { w: GADGET.id }
    await openEditor('desktop')
    expect(admissions).toHaveLength(admitted + 1)
    expect(snapshots.map(s => s.gadgetId)).toEqual([GADGET.id, GADGET.id])
  })

  it('opens a gadget that requires accounts as a snapshot without verifying, and one that requires none live', async () => {
    requiringAccounts = new Set([GADGET.id])
    mocks.search = { w: GADGET.id }
    await openEditor('desktop')
    expect(admissions).toHaveLength(0)
    expect(snapshots.map(s => s.gadgetId)).toEqual([GADGET.id])
    await act(async () => snapshots[0].resolve())
    expect(shownClient()).toBe(snapshots[0].client)

    mocks.search = { w: BUDGET.id }
    await openEditor('desktop')
    expect(snapshots[0].client.disposed).toBe(true)
    expect(snapshots).toHaveLength(1)
    expect(admissions).toHaveLength(1)
    expect(workspace.createObserverConfigCallback).toHaveBeenLastCalledWith(
      expect.any(AbortSignal), { id: BUDGET.id, offersSnapshot: true })
  })

  it('verifies for the live gadget over its snapshot, which stays until admission succeeds', async () => {
    requiringAccounts = new Set([GADGET.id])
    mocks.search = { w: GADGET.id }
    await openEditor('desktop')
    await act(async () => snapshots[0].resolve())
    const snapshot = snapshots[0].client
    const admitted = admissions.length

    // Its prompt offers no snapshot, and cancelling it keeps the snapshot.
    await act(async () => mocks.useView!.snapshot!.onVerify())
    expect(workspace.createObserverConfigCallback).toHaveBeenLastCalledWith(
      expect.any(AbortSignal), { id: GADGET.id, offersSnapshot: false })
    expect(admissions).toHaveLength(admitted + 1)
    expect(mocks.useView?.snapshot?.verifying).toBe(true)
    expect(shownClient()).toBe(snapshot)
    // A re-render neither restarts nor ends the verification.
    await openEditor('desktop')
    expect(admissions).toHaveLength(admitted + 1)
    expect(mocks.useView?.snapshot?.verifying).toBe(true)
    await act(async () => admissions.at(-1)!.reject(new Error('cancelled')))
    expect(mocks.useView?.snapshot?.verifying).toBe(false)
    expect(shownClient()).toBe(snapshot)
    expect(snapshot.disposed).toBe(false)

    // Passing replaces the snapshot with the stub that admission produced, admitting no second time.
    await act(async () => mocks.useView!.snapshot!.onVerify())
    await act(async () => admissions.at(-1)!.resolve())
    expect(admissions).toHaveLength(admitted + 2)
    expect(snapshot.disposed).toBe(true)
    expect(mocks.useView?.snapshot).toBeNull()
    expect(shownClient()).toMatchObject({ gadgetId: GADGET.id, disposed: false })
    expect(shownClient()).not.toBe(snapshot)

    // From then on it opens live, its prompt offering the snapshot back.
    workspace.overseer = useOnlyOverseer()
    await openEditor('desktop')
    expect(admissions).toHaveLength(admitted + 3)
    expect(snapshots).toHaveLength(1)
    expect(workspace.createObserverConfigCallback).toHaveBeenLastCalledWith(
      expect.any(AbortSignal), { id: GADGET.id, offersSnapshot: true })
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
