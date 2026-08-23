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

// The identity the mocked session reports, and the stamp share-key retention stores under it.
const WHOAMI_USER = { type: 'user', id: 'person@example.com', name: 'Person' }

function api(overseer: RpcStub<Overseer>): RpcStub<AuthenticatedApi> {
  return {
    openGadget: () => overseer,
    whoami: async () => WHOAMI_USER,
  } as unknown as RpcStub<AuthenticatedApi>
}

const RETAINED_V2_KEY = 'gadgets:retained-share-key:v2:workspace-1'

function retainedEntry(key: string, userId = WHOAMI_USER.id): string {
  return JSON.stringify({ key, userId })
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
      whoami: async () => WHOAMI_USER,
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
    // The persisted entry is stamped with the capturing session's identity.
    expect(sessionStorage.getItem(RETAINED_V2_KEY)).toBe(retainedEntry('deadbeef'))

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
      whoami: async () => WHOAMI_USER,
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
    // The open succeeded, so the persisted secret is gone -- even though the identity stamp
    // that writes it resolves asynchronously alongside the open...
    expect(sessionStorage.getItem(RETAINED_V2_KEY)).toBeNull()

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
      whoami: async () => WHOAMI_USER,
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

  it('ignores and sweeps a retained key stamped by a different user', async () => {
    // The shared-tab user switch: A's failed keyed open left a retained entry, A logged out
    // without the sweep landing (or the entry predates it), and B opens the same workspace. The
    // key must not be redeemed under B's account, and the stale entry goes away.
    sessionStorage.setItem(RETAINED_V2_KEY, retainedEntry('cafe', 'someone-else@example.com'))
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
      whoami: async () => WHOAMI_USER,
    } as unknown as RpcStub<AuthenticatedApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={authenticatedApi} />))

    expect(sentKeys).toEqual([undefined])
    expect(sessionStorage.getItem(RETAINED_V2_KEY)).toBeNull()
  })

  it('neither attaches nor sweeps the retained key when identity cannot be resolved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // A transport failure leaves the identity unknown: the entry may well belong to this user,
    // so it must survive for a later attempt, but the key must not be attached blind.
    sessionStorage.setItem(RETAINED_V2_KEY, retainedEntry('cafe'))
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
      whoami: async () => { throw new Error('connection lost') },
    } as unknown as RpcStub<AuthenticatedApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={authenticatedApi} />))

    expect(sentKeys).toEqual([undefined])
    expect(sessionStorage.getItem(RETAINED_V2_KEY)).toBe(retainedEntry('cafe'))
  })

  it('abandons a superseded attempt parked in identity resolution before it opens anything', async () => {
    // The retained-storage path awaits whoami() before openGadget. An attempt superseded while
    // parked there already had its cleanup run -- with nothing yet to dispose -- so if it
    // proceeded, it would mint a capability its cleanup can never reach and publish it over the
    // replacement attempt's state.
    sessionStorage.setItem(RETAINED_V2_KEY, retainedEntry('cafe'))
    const heldWhoami = deferred<typeof WHOAMI_USER>()
    const staleOpenGadget = vi.fn<() => RpcStub<Overseer>>()
    const staleApi = {
      openGadget: staleOpenGadget,
      whoami: () => heldWhoami.promise,
    } as unknown as RpcStub<AuthenticatedApi>

    const subscription = disposableStub({}) as RpcStub<{}>
    const freshOverseerDispose = vi.fn<() => void>()
    const freshOverseer = disposableStub({
      subscribeToMetadata:
          vi.fn<(callback: (metadata: GadgetMetadata) => void) => Promise<RpcStub<{}>>>(
              async callback => {
                callback(METADATA)
                return subscription
              }),
    }, freshOverseerDispose) as unknown as RpcStub<Overseer>
    const freshApi = api(freshOverseer)

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    // The stale attempt parks inside whoami(); replacing the API cancels it and starts a fresh
    // attempt, which succeeds (and clears the retained entry).
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={staleApi} />))
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={freshApi} />))
    expect(container.textContent).toBe(METADATA.title)

    await act(async () => { heldWhoami.resolve(WHOAMI_USER); await Promise.resolve() })

    // The stale attempt resumed after its own cleanup and must have gone no further.
    expect(staleOpenGadget).not.toHaveBeenCalled()
    expect(freshOverseerDispose).not.toHaveBeenCalled()
    expect(container.textContent).toBe(METADATA.title)
  })

  it('never replays the in-memory key on a different session stub', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // User A's keyed open fails, retaining the key in-memory. The editor then re-renders with a
    // different authenticated stub -- without unmounting -- representing user B. The in-memory
    // ref must not be replayed on it: the ref is bound to the stub that captured it, and the
    // fall-through sessionStorage read is identity-checked, so B ends up keyless.
    window.location.hash = '#share=deadbeef'
    const deniedOverseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => {
        throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied)
      }),
    }) as unknown as RpcStub<Overseer>
    const apiA = {
      openGadget: () => deniedOverseer,
      whoami: async () => WHOAMI_USER,
    } as unknown as RpcStub<AuthenticatedApi>
    const keysSentToB: (string | undefined)[] = []
    const apiB = {
      openGadget: (_id: string, shareKey?: string) => {
        keysSentToB.push(shareKey)
        return deniedOverseer
      },
      whoami: async () => ({ type: 'user', id: 'other@example.com', name: 'Other' }),
    } as unknown as RpcStub<AuthenticatedApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={apiA} />))
    window.location.hash = ''
    // A's async identity stamp has landed by now, so the storage tier holds A's stamped entry.
    expect(sessionStorage.getItem(RETAINED_V2_KEY)).toBe(retainedEntry('deadbeef'))

    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={apiB} />))

    expect(keysSentToB).toEqual([undefined])
    // The stamped entry definitely belongs to someone else, so it was swept, not just skipped.
    expect(sessionStorage.getItem(RETAINED_V2_KEY)).toBeNull()
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
