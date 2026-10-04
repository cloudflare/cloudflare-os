// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GadgetMetadata,
  GadgetSummary,
  WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'

// Covers which gadgets the editor offers "Update from blueprint" for, and what it does once that
// has produced a proposal: the proposal lives in a new chat, which the editor has to bring into
// view. Everything the editor composes is stubbed down to the callbacks that drive its layout.

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
    navigate: vi.fn<(options: { search: (prev: Record<string, unknown>) => unknown }) => void>(),
    workspace: {
      overseer: {
        stub: {
          subscribeToWorkpieces: async (subscriber: WorkpiecesSubscriber) => {
            await subscriber.entry(GADGET)
            await subscriber.ready()
            return disposable
          },
          getGadget: () => disposable,
          listHooks: async () => [],
          subscribeToConsoleLogs: async () => disposable,
        },
      },
      metadata: { id: 'workspace', title: 'Trips', role: 'build' } as unknown as GadgetMetadata,
      error: null,
      connectionLost: false,
      observerConfig: null,
      retry: () => {},
      cancelObserverConfig: () => {},
      updateTitle: () => {},
    },
    authenticatedApi: { whoami: async () => ({ type: 'user', id: 'dev', name: 'Dev' }) },
  }
})

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: 'workspace' }),
  useNavigate: () => mocks.navigate,
  useSearch: () => ({}),
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
vi.mock('./useWorkspaceOpen', () => ({ useWorkspaceOpen: () => mocks.workspace }))
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
vi.mock('./GadgetUseView', () => ({ default: () => null }))
vi.mock('./ObserverConfigModal', () => ({ default: () => null }))
vi.mock('./ShareModal', () => ({ default: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))
vi.mock('./components/DeleteConfirmationDialog', () => ({ default: () => null }))
vi.mock('./components/ReconnectingChip', () => ({ default: () => null }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./components/WorkspaceOpenErrorPage', () => ({ default: () => null }))

import GadgetEditor from './GadgetEditor'

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
