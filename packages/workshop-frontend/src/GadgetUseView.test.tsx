// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { RpcStub } from 'capnweb'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AuthenticatedApi,
  GadgetClient,
  GadgetSummary,
  Overseer,
  WorkpieceId,
  WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'

// Covers what the use-only view hands the gadget's UI: where the uncaught errors of a use
// collaborator's frame are reported, from the view on. What the editor hands this view is covered
// by the editor's own suite.

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const mocks = vi.hoisted(() => ({
  // The props the gadget's UI was last rendered with.
  gadgetUI: null as null | { overseer: unknown; gadget: unknown; gadgetId: WorkpieceId },
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
}))
vi.mock('./GadgetUI', () => ({
  default: (props: NonNullable<typeof mocks.gadgetUI>) => {
    mocks.gadgetUI = props
    return null
  },
}))
vi.mock('./components/SiteLogo', () => ({ default: () => null }))
vi.mock('./components/format/FormatVisuals', () => ({ FormatGlyph: () => null }))
vi.mock('./GadgetExportMenu', () => ({ default: () => null }))
vi.mock('./components/GadgetPresence', () => ({ GadgetPresence: () => null }))
vi.mock('./components/UserMenu', () => ({ default: () => null }))
vi.mock('./TopBarNotice', () => ({ default: () => null }))

import GadgetUseView from './GadgetUseView'

const GADGETS: GadgetSummary[] = [
  { id: 1, type: 'gadget', title: 'Itinerary', commitId: 'head' },
  { id: 2, type: 'gadget', title: 'Budget', commitId: 'head' },
]
const SELECTED = GADGETS[1].id

const fakeOverseer = () => ({}) as unknown as RpcStub<Overseer>
const client = {} as unknown as RpcStub<GadgetClient>

describe('GadgetUseView', () => {
  let container: HTMLDivElement
  let root: Root
  let overseer: RpcStub<Overseer>

  /** Renders the view with the second gadget open, but for `props`. */
  const renderView = (props: Partial<ComponentProps<typeof GadgetUseView>> = {}) => act(async () => {
    root.render(
      <GadgetUseView
        overseer={overseer}
        gadget={client}
        selectedGadgetId={SELECTED}
        gadgets={GADGETS}
        gadgetOpenFailure={null}
        onRetryGadget={() => {}}
        onSelectGadget={() => {}}
        metadata={{ id: 'workspace', title: 'Trips', role: 'use' } as unknown as WorkspaceMetadata}
        authenticatedApi={{} as unknown as RpcStub<AuthenticatedApi>}
        currentUserId={null}
        {...props}
      />,
    )
  })

  beforeEach(() => {
    mocks.gadgetUI = null
    overseer = fakeOverseer()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it("tells the gadget's UI where to report its uncaught errors", async () => {
    await renderView()
    expect(mocks.gadgetUI?.overseer).toBe(overseer)
    expect(mocks.gadgetUI?.gadgetId).toBe(SELECTED)
    expect(mocks.gadgetUI?.gadget).toBe(client)

    // A reconnect hands the view another stub for its workspace.
    const reconnected = fakeOverseer()
    await renderView({ overseer: reconnected })
    expect(mocks.gadgetUI?.overseer).toBe(reconnected)
    expect(mocks.gadgetUI?.gadgetId).toBe(SELECTED)
  })

  it('mounts the UI exactly when a gadget is open', async () => {
    // The gadget is being admitted.
    await renderView({ gadget: null })
    expect(mocks.gadgetUI).toBeNull()

    await renderView({ gadgetOpenFailure: 'The gadget could not be opened.' })
    expect(mocks.gadgetUI).toBeNull()

    // The workspace has no gadget: there is no id to report under.
    await renderView({ selectedGadgetId: null })
    expect(mocks.gadgetUI).toBeNull()

    await renderView()
    expect(mocks.gadgetUI).not.toBeNull()
  })
})
