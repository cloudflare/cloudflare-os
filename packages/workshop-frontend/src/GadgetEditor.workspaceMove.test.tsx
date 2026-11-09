// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { useEffect, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Covers where a gadget view's console output is reported when the editor moves from one
// workspace to another. A view's reporter sends its queue through the latest stub the view was
// given (useGadgetConsoleLogReporter), and gadget ids start at 0 in every workspace, so a view
// re-rendered with the next workspace's stub would report what it captured in the workspace being
// left into the next one's history. The editor, its workspace hook, the gadget view and the
// reporter are the real ones, over stubs that record which workspace each report reached.
//
// React schedules its renders and effect flushes as it does in the app, with no act(): one case is
// an answer from the workspace being left that arrives between the effects that reset the editor
// and the render they schedule.

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = false
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

type Report = { workspace: string; gadgetId: unknown; chatId: unknown; texts: string[] }
type ListSubscriber = { entry(summary: unknown): unknown; ready(): unknown }

const mocks = vi.hoisted(() => {
  const disposable = { [Symbol.dispose]() {} }
  const state = {
    // The workspace the route names.
    id: 'A',
    api: null as unknown,
    // Every report made, with the workspace whose stub it was made through.
    reports: [] as Report[],
    // The workspaces whose workpiece listing has answered.
    listed: [] as string[],
    // When set, a listing of workspace A does not answer, and its subscriber is kept here.
    holdListingOfA: false,
    heldSubscriberOfA: null as ListSubscriber | null,
    // When set, the held listing answers as workspace B is opened.
    answerHeldListingAsBOpens: false,
  }

  // Every workspace's first gadget has id 0.
  const list = (workspace: string, subscriber: ListSubscriber) => {
    subscriber.entry({ id: 0, type: 'gadget', title: `${workspace}'s gadget`, commitId: 'head' })
    subscriber.ready()
    state.listed.push(workspace)
  }

  const overseerFor = (workspace: string) => {
    let disposed = false
    return {
      reportGadgetConsoleLogs: (gadgetId: unknown, chatId: unknown, entries: { text: string }[]) => {
        state.reports.push({ workspace, gadgetId, chatId, texts: entries.map(entry => entry.text) })
        return disposed
          ? Promise.reject(new Error('Attempted to use RPC stub after it has been disposed'))
          : Promise.resolve()
      },
      subscribeToMetadata: async (callback: (metadata: unknown) => void) => {
        callback({ id: workspace, title: `Workspace ${workspace}`, role: 'build' })
        return disposable
      },
      subscribeToWorkpieces: async (subscriber: ListSubscriber) => {
        if (workspace === 'A' && state.holdListingOfA) {
          state.heldSubscriberOfA = subscriber
          return new Promise<never>(() => {})
        }
        list(workspace, subscriber)
        return disposable
      },
      getGadget: () => ({
        getUiBundle: async () => ({ jsCode: '' }),
        connectToGadget: async () => { throw new Error('No test here connects to a gadget') },
        [Symbol.dispose]() {},
      }),
      listHooks: async () => [],
      subscribeToConsoleLogs: async () => disposable,
      [Symbol.dispose]() { disposed = true },
    }
  }

  return {
    state,
    navigate: vi.fn<() => void>(),
    // A connection: the editor's workspace hook opens the route's workspace again on a new one.
    makeApi: () => ({
      whoami: async () => ({ type: 'user', id: 'dev', name: 'Dev' }),
      listWorkspaces: async () => [],
      openWorkspace: (workspace: string) => {
        const held = state.heldSubscriberOfA
        if (workspace === 'B' && state.answerHeldListingAsBOpens && held) {
          // The workspace hook opens B inside the effect flush that resets the editor, so a
          // microtask queued here runs after that flush and before the render it scheduled.
          queueMicrotask(() => list('A', held))
        }
        return overseerFor(workspace)
      },
    }),
  }
})

vi.mock('@tanstack/react-router', () => ({
  useParams: () => ({ id: mocks.state.id }),
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
      Item: ({ children }: { children: ReactNode }) => <button type="button">{children}</button>,
      Separator: () => <hr />,
    },
  )
  return {
    DropdownMenu,
    useKumoToastManager: () => ({ add: () => {} }),
    Banner: () => null,
    Loader: () => null,
    Text: ({ children }: { children: ReactNode }) => children,
  }
})

vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: mocks.state.api }),
}))
vi.mock('./RpcContext', () => ({ useConnectionLost: () => false, useRpcStub: () => ({}) }))
// Not mocked: ./useWorkspaceOpen, ./GadgetUI, and the reporter and its hook.
vi.mock('./useActions', () => ({
  useActions: () => ({ pending: [] }), useActionEntries: () => {}, linkActionLog: () => {},
}))
vi.mock('./errorReporting', () => ({ reportIssue: () => {} }))
vi.mock('./features/blueprint-updates/useBlueprintUpdateAvailable', () => ({
  useBlueprintUpdateAvailable: () => false,
}))
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
vi.mock('./features/blueprint-updates/UpdateFromBlueprintDialog', () => ({ UpdateFromBlueprintDialog: () => null }))
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
vi.mock('./GadgetUseView', () => ({ default: () => null }))
vi.mock('./ObserverConfigModal', () => ({ default: () => null }))
vi.mock('./ShareModal', () => ({ default: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))
vi.mock('./components/DeleteConfirmationDialog', () => ({ default: () => null }))
vi.mock('./components/ReconnectingChip', () => ({ default: () => null }))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./components/WorkspaceOpenErrorPage', () => ({
  default: () => null,
  classifyWorkspaceOpenFailure: () => 'unexpected',
}))
vi.mock('./features/notifications/WorkspaceNotificationsMenu', () => ({ WorkspaceNotificationsMenu: () => null }))

import GadgetEditor from './GadgetEditor'

const A_TEXT = "workspace A's console output"

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Object.assign(mocks.state, {
    id: 'A', api: mocks.makeApi(), reports: [], listed: [], holdListingOfA: false,
    heldSubscriberOfA: null, answerHeldListingAsBOpens: false,
  })
  localStorage.clear()
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) })
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  root.unmount()
  // The unmount's effect cleanups run in a task of their own.
  await new Promise(resolve => setTimeout(resolve))
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(window, 'matchMedia')
  container.remove()
})

const frame = () => container.querySelector('iframe')

// Opens workspace A and waits for its gadget's view.
async function openA() {
  root.render(<GadgetEditor />)
  await vi.waitFor(() => expect(frame()).not.toBeNull())
}

// A console call in the frame of the gadget on screen, which its view's reporter queues.
function logInFrame(text: string) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'console', level: 'warn', message: [text] },
    origin: 'null',
    source: frame()!.contentWindow,
  }))
}

// Moves the route to workspace B, waits for its gadget's view, and has every mounted view send
// what it holds, as a tab that is hidden does.
async function moveToB() {
  mocks.state.id = 'B'
  root.render(<GadgetEditor />)
  await vi.waitFor(() => {
    expect(mocks.state.listed).toContain('B')
    expect(frame()).not.toBeNull()
  })
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  document.dispatchEvent(new Event('visibilitychange'))
}

// The one report of these cases: the queue of A's view, sent as the view goes, through the last
// stub of A the view was given. Nothing of it reaches B.
const REPORT_TO_A = { workspace: 'A', gadgetId: 0, chatId: null, texts: [A_TEXT] }

describe("GadgetEditor, moving to another workspace with a gadget's console output queued", () => {
  it('reports the output to the workspace it was captured in', async () => {
    await openA()
    logInFrame(A_TEXT)
    expect(mocks.state.reports).toEqual([])

    await moveToB()
    expect(mocks.state.reports).toEqual([REPORT_TO_A])
  })

  it('does so when a listing of the workspace being left answers as the next one opens', async () => {
    await openA()

    // The connection is replaced inside A: the editor lists A again through its next stub, and
    // keeps the gadget's view mounted meanwhile.
    mocks.state.holdListingOfA = true
    mocks.state.api = mocks.makeApi()
    root.render(<GadgetEditor />)
    await vi.waitFor(() => expect(mocks.state.heldSubscriberOfA).not.toBeNull())
    expect(frame()).not.toBeNull()
    logInFrame(A_TEXT)
    expect(mocks.state.reports).toEqual([])

    mocks.state.answerHeldListingAsBOpens = true
    await moveToB()
    expect(mocks.state.listed).toEqual(['A', 'A', 'B'])
    expect(mocks.state.reports).toEqual([REPORT_TO_A])
  })
})
