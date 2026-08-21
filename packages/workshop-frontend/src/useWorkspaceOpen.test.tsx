// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  createOpenGadgetError,
  OPEN_GADGET_ERROR_CODES,
  type AuthenticatedApi,
  type GadgetMetadata,
  type Overseer,
} from '@gadgets/workshop-shared/api'
import WorkspaceOpenErrorPage from './components/WorkspaceOpenErrorPage'
import { useWorkspaceOpen } from './useWorkspaceOpen'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

function disposableStub<T extends object>(value: T, dispose = vi.fn<() => void>()) {
  return Object.assign(value, { [Symbol.dispose]: dispose }) as T & Disposable
}

function api(overseer: RpcStub<Overseer>): RpcStub<AuthenticatedApi> {
  return { openGadget: () => overseer } as unknown as RpcStub<AuthenticatedApi>
}

const METADATA = {
  id: 'workspace-1',
  title: 'Quarterly planning',
  provisional: false,
} as GadgetMetadata

function WorkspaceProbe({ authenticatedApi }: { authenticatedApi: RpcStub<AuthenticatedApi> }) {
  const state = useWorkspaceOpen({
    id: 'workspace-1',
    authenticatedApi,
    onInvalidShareKey: () => {},
    onMetadata: () => {},
    onShareKeyConsumed: () => {},
  })
  if (state.error?.kind === 'open') {
    return (
      <WorkspaceOpenErrorPage
        kind={state.error.failure}
        onGoToWorkspaces={() => {}}
        onRetry={state.retry}
      />
    )
  }
  return <p>{state.metadata?.title}</p>
}

describe('useWorkspaceOpen', () => {
  let root: Root | undefined
  let container: HTMLDivElement | undefined

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    document.title = ''
    window.location.hash = ''
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('disposes a metadata subscription that resolves after its load attempt is cleaned up', async () => {
    const pendingSubscription = deferred<RpcStub<{}>>()
    const overseerDispose = vi.fn<() => void>()
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(() => pendingSubscription.promise),
    }, overseerDispose) as unknown as RpcStub<Overseer>
    const subscriptionDispose = vi.fn<() => void>()
    const subscription = disposableStub({}, subscriptionDispose) as RpcStub<{}>
    const authenticatedApi = api(overseer)

    function Probe() {
      useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        onShareKeyConsumed: () => {},
      })
      return null
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))

    act(() => root!.unmount())
    root = undefined
    await act(async () => { pendingSubscription.resolve(subscription); await Promise.resolve() })

    expect(overseerDispose).toHaveBeenCalledOnce()
    expect(subscriptionDispose).toHaveBeenCalledOnce()
  })

  it('persists the fragment share key and re-sends it after a reload', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    window.location.hash = '#share=deadbeef'
    const sentKeys: (string | undefined)[] = []
    const deniedOverseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => {
        throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied)
      }),
    }) as unknown as RpcStub<Overseer>
    const authenticatedApi = {
      openGadget: (_id: string, shareKey?: string) => {
        sentKeys.push(shareKey)
        return deniedOverseer
      },
    } as unknown as RpcStub<AuthenticatedApi>

    function Probe() {
      useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        // The app strips the fragment before the open is issued; mirror that here so the
        // second mount can only recover the key from storage.
        onShareKeyConsumed: () => { window.location.hash = '' },
      })
      return null
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))
    expect(sentKeys).toEqual(['deadbeef'])
    expect(window.location.hash).toBe('')

    // A reload drops the hook's in-memory ref: unmount and mount a fresh root. The failed open
    // never cleared the persisted key, so the fresh mount re-sends it instead of dead-ending on
    // the access-denied page.
    act(() => root!.unmount())
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))
    expect(sentKeys).toEqual(['deadbeef', 'deadbeef'])
  })

  it('clears the persisted key on a successful open', async () => {
    window.location.hash = '#share=cafe'
    const sentKeys: (string | undefined)[] = []
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<
        (callback: (metadata: GadgetMetadata) => void) => Promise<RpcStub<{}>>
      >(async callback => {
          callback(METADATA)
          return disposableStub({}) as RpcStub<{}>
        }),
    }) as unknown as RpcStub<Overseer>
    const authenticatedApi = {
      openGadget: (_id: string, shareKey?: string) => {
        sentKeys.push(shareKey)
        return overseer
      },
    } as unknown as RpcStub<AuthenticatedApi>

    let retry!: () => void
    function Probe() {
      const state = useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        onShareKeyConsumed: () => { window.location.hash = '' },
      })
      retry = state.retry
      return null
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe />))
    expect(sentKeys).toEqual(['cafe'])
    // The open succeeded, so the persisted secret is gone...
    expect(sessionStorage.getItem('gadgets:retained-share-key:v1:workspace-1')).toBeNull()

    // ...and so is the in-memory ref: a retry resolves keylessly from the confirmed edge.
    await act(async () => retry())
    expect(sentKeys).toEqual(['cafe', undefined])
  })

  it('a reconnect after a successful open retries keylessly', async () => {
    // The owner-removal scenario: the revocation restart kills the WebSocket, useAuth swaps in
    // a new authenticatedApi while the editor stays mounted, and the open effect re-runs. A
    // retained key here would silently re-redeem the still-active link, undoing the removal.
    window.location.hash = '#share=cafe'
    const sentKeys: (string | undefined)[] = []
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<
        (callback: (metadata: GadgetMetadata) => void) => Promise<RpcStub<{}>>
      >(async callback => {
          callback(METADATA)
          return disposableStub({}) as RpcStub<{}>
        }),
    }) as unknown as RpcStub<Overseer>
    // Each call yields a distinct stub identity, like a fresh post-reconnect connection.
    const keyedApi = () => ({
      openGadget: (_id: string, shareKey?: string) => {
        sentKeys.push(shareKey)
        return overseer
      },
    } as unknown as RpcStub<AuthenticatedApi>)

    function Probe({ authenticatedApi }: { authenticatedApi: RpcStub<AuthenticatedApi> }) {
      useWorkspaceOpen({
        id: 'workspace-1',
        authenticatedApi,
        onInvalidShareKey: () => {},
        onMetadata: () => {},
        onShareKeyConsumed: () => { window.location.hash = '' },
      })
      return null
    }

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<Probe authenticatedApi={keyedApi()} />))
    expect(sentKeys).toEqual(['cafe'])

    await act(async () => root!.render(<Probe authenticatedApi={keyedApi()} />))
    expect(sentKeys).toEqual(['cafe', undefined])
  })

  it('clears loaded metadata and title and disposes the failed stub after access is denied', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    document.title = 'outside'
    const firstSubscriptionDispose = vi.fn<() => void>()
    const firstOverseer = disposableStub({
      subscribeToMetadata: vi.fn<
        (callback: (metadata: GadgetMetadata) => void) => Promise<RpcStub<{}>>
      >(async callback => {
          callback(METADATA)
          return disposableStub({}, firstSubscriptionDispose) as RpcStub<{}>
        }),
    }) as unknown as RpcStub<Overseer>
    const deniedOverseerDispose = vi.fn<() => void>()
    const deniedOverseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => {
        throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied)
      }),
    }, deniedOverseerDispose) as unknown as RpcStub<Overseer>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(firstOverseer)} />))
    expect(container.textContent).toContain('Quarterly planning')
    expect(document.title).toBe('Quarterly planning - Cloudflare OS')

    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={api(deniedOverseer)} />))
    expect(container.textContent).toContain("You don't have access to this workspace")
    expect(container.textContent).not.toContain('Quarterly planning')
    expect(document.title).toBe('Cloudflare OS')
    expect(firstSubscriptionDispose).toHaveBeenCalledOnce()
    expect(deniedOverseerDispose).toHaveBeenCalledOnce()
  })
})
