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

// An overseer whose open() itself is denied server-side: openGadget's pipelined RpcPromise
// surfaces that as a rejection when awaited, before any method on it resolves. This is where a
// share-key denial really lands -- the server refuses inside open(), so subscribeToMetadata is
// never the first thing to fail on a denied keyed open.
function openDeniedOverseer(error: unknown = createOpenGadgetError(
    OPEN_GADGET_ERROR_CODES.workspaceAccessDenied)): RpcStub<Overseer> {
  return disposableStub({
    // Being awaitable is the point: it mimics the RpcPromise openGadget returns, whose
    // rejection is how an open denial surfaces.
    // oxlint-disable-next-line unicorn/no-thenable
    then(_onFulfilled: unknown, onRejected: (reason: unknown) => void) {
      onRejected(error)
    },
  }) as unknown as RpcStub<Overseer>
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

// Seeds storage the way a previous attempt's stamp would have left it. Deterministic, so a test
// that expects the entry untouched can compare the raw string.
function retainedEntry(key: string, userId = WHOAMI_USER.id, captureId = 'capture-test'): string {
  return JSON.stringify({ key, userId, captureId })
}

// Entries the hook itself writes carry a random capture id, so tests assert on the parsed shape
// (toMatchObject) rather than the raw string.
function storedRetained(): unknown {
  const raw = sessionStorage.getItem(RETAINED_V2_KEY)
  return raw === null ? null : JSON.parse(raw)
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
    const authenticatedApi = {
      openGadget: (_id: string, shareKey?: string) => {
        sentKeys.push(shareKey)
        return openDeniedOverseer()
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
    expect(storedRetained()).toMatchObject({ key: 'deadbeef', userId: WHOAMI_USER.id })

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

  it('clears retention once the keyed open resolves, even if the metadata subscribe fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    window.location.hash = '#share=cafe'
    const sentKeys: (string | undefined)[] = []
    // The open itself succeeds -- the server confirmed the redemption before the client held the
    // capability -- but the follow-up subscribe fails, as it really can for exactly the keyed
    // audience (the non-owner whoami round trip, a WS drop).
    const overseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => {
        throw new Error('connection lost during subscribe')
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
    // The redemption is confirmed, so both retention tiers are already gone -- a key kept until
    // subscribeToMetadata succeeded would arm every retry path with a silent re-redemption of
    // the still-active link after an owner removal.
    expect(sessionStorage.getItem(RETAINED_V2_KEY)).toBeNull()

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

  it("a cancelled attempt parked in identity resolution cannot sweep a newer attempt's retention", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Attempt A reads a retained entry and parks in whoami(). It is superseded by B (a swapped
    // stub, another user), whose own capture replaces the entry. A's identity then resolves and
    // mismatches the entry A read -- but A no longer owns retention: judging the stale read
    // there would sweep B's entry and (pre-fix, via the unscoped clear's workspace-generation
    // bump) void B's in-flight stamps.
    sessionStorage.setItem(RETAINED_V2_KEY, retainedEntry('cafe', 'someone-else@example.com'))
    const heldWhoami = deferred<typeof WHOAMI_USER>()
    const staleOpenGadget = vi.fn<() => RpcStub<Overseer>>()
    const staleApi = {
      openGadget: staleOpenGadget,
      whoami: () => heldWhoami.promise,
    } as unknown as RpcStub<AuthenticatedApi>
    const OTHER_USER = { type: 'user', id: 'other@example.com', name: 'Other' }
    const apiB = {
      openGadget: () => openDeniedOverseer(),
      whoami: async () => OTHER_USER,
    } as unknown as RpcStub<AuthenticatedApi>

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
    await act(async () => root!.render(<Probe authenticatedApi={staleApi} />))

    // B captures its own key on the swapped stub; the denied open leaves it retained and stamped.
    window.location.hash = '#share=bbbb'
    await act(async () => root!.render(<Probe authenticatedApi={apiB} />))
    expect(storedRetained()).toMatchObject({ key: 'bbbb', userId: OTHER_USER.id })

    // A resumes with an identity that mismatches the entry it read: it must bail before
    // mutating anything, leaving B's entry (and B's write license) intact.
    await act(async () => { heldWhoami.resolve(WHOAMI_USER); await Promise.resolve() })
    expect(staleOpenGadget).not.toHaveBeenCalled()
    expect(storedRetained()).toMatchObject({ key: 'bbbb', userId: OTHER_USER.id })
  })

  it('never replays the in-memory key on a different session stub', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // User A's keyed open is denied at open(), retaining the key in-memory. The editor then
    // re-renders with a different authenticated stub -- without unmounting -- representing user
    // B. The in-memory ref must not be replayed on it: the ref is bound to the stub that
    // captured it, and the fall-through sessionStorage read is identity-checked, so B ends up
    // keyless.
    window.location.hash = '#share=deadbeef'
    const deniedOverseer = disposableStub({
      subscribeToMetadata: vi.fn<() => Promise<RpcStub<{}>>>(async () => {
        throw createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied)
      }),
    }) as unknown as RpcStub<Overseer>
    const apiA = {
      openGadget: () => openDeniedOverseer(),
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
    expect(storedRetained()).toMatchObject({ key: 'deadbeef', userId: WHOAMI_USER.id })

    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={apiB} />))

    expect(keysSentToB).toEqual([undefined])
    // The stamped entry definitely belongs to someone else, so it was swept, not just skipped.
    expect(sessionStorage.getItem(RETAINED_V2_KEY)).toBeNull()
  })

  it('a late identity stamp cannot resurrect an entry a later attempt cleared', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Attempt A captures the fragment key and starts its async identity stamp, which parks. A's
    // open is denied; the retry replays the in-memory key and succeeds, discarding both
    // retention tiers. When A's stamp finally resolves, it must not write the entry back: a
    // resurrected key would silently re-redeem the still-active link after an owner removes
    // this collaborator.
    window.location.hash = '#share=deadbeef'
    const heldWhoami = deferred<typeof WHOAMI_USER>()
    const goodOverseer = disposableStub({
      subscribeToMetadata:
          vi.fn<(callback: (metadata: GadgetMetadata) => void) => Promise<RpcStub<{}>>>(
              async callback => {
                callback(METADATA)
                return disposableStub({}) as RpcStub<{}>
              }),
    }) as unknown as RpcStub<Overseer>
    let opens = 0
    const authenticatedApi = {
      openGadget: () => (++opens === 1 ? openDeniedOverseer() : goodOverseer),
      whoami: () => heldWhoami.promise,
    } as unknown as RpcStub<AuthenticatedApi>

    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<WorkspaceProbe authenticatedApi={authenticatedApi} />))
    window.location.hash = ''
    await act(async () => {
      const retryButton = [...container!.querySelectorAll('button')]
          .find(button => button.textContent?.includes('Try again'))
      retryButton!.click()
      await Promise.resolve()
    })
    expect(container.textContent).toBe(METADATA.title)
    expect(sessionStorage.getItem(RETAINED_V2_KEY)).toBeNull()

    await act(async () => { heldWhoami.resolve(WHOAMI_USER); await Promise.resolve() })
    expect(sessionStorage.getItem(RETAINED_V2_KEY)).toBeNull()
  })

  it("a superseded keyed open cannot clear a newer attempt's retained key", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Attempt A's keyed open parks inside the await on the open itself. While it is parked, the
    // session stub is swapped (a reconnect, here as another user) and attempt B captures its own
    // fragment key, whose open is denied -- so B retains it for a retry, by design. A's late
    // resolution runs after A's own cleanup and no longer owns the retention state: clearing it
    // there would wipe B's in-memory ref and sessionStorage entry and (via the write-token bump)
    // permanently void B's still-in-flight identity stamp, dead-ending B's retry unretryably.
    window.location.hash = '#share=aaaa'
    const heldOpen = deferred<void>()
    const parkedOverseer = disposableStub({
      // oxlint-disable-next-line unicorn/no-thenable
      then(onFulfilled: () => void) {
        void heldOpen.promise.then(onFulfilled)
      },
    }) as unknown as RpcStub<Overseer>
    const apiA = {
      openGadget: () => parkedOverseer,
      whoami: async () => WHOAMI_USER,
    } as unknown as RpcStub<AuthenticatedApi>
    const OTHER_USER = { type: 'user', id: 'other@example.com', name: 'Other' }
    const apiB = {
      openGadget: () => openDeniedOverseer(),
      whoami: async () => OTHER_USER,
    } as unknown as RpcStub<AuthenticatedApi>

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
    await act(async () => root!.render(<Probe authenticatedApi={apiA} />))

    // B captures its own key on the swapped stub; the denied open leaves it retained and stamped.
    window.location.hash = '#share=bbbb'
    await act(async () => root!.render(<Probe authenticatedApi={apiB} />))
    expect(storedRetained()).toMatchObject({ key: 'bbbb', userId: OTHER_USER.id })

    // A's parked open resolves after A was superseded: B's retention must survive untouched.
    await act(async () => { heldOpen.resolve(); await Promise.resolve() })
    expect(storedRetained()).toMatchObject({ key: 'bbbb', userId: OTHER_USER.id })
  })

  it("a superseded keyed open cannot clear a newer capture of the same key", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // The same-tab user switch where B clicks the *same* invite link A used. A's keyed open of
    // key K parks inside the await on the open itself; the stub is swapped and B captures the
    // very same K, whose open is denied -- so B retains it for a retry. A's late success clears
    // only A's own capture: were the clear keyed on the raw key, it would remove B's entry and
    // permanently void B's write license, dead-ending B's retry on the access-denied page.
    window.location.hash = '#share=aaaa'
    const heldOpen = deferred<void>()
    const parkedOverseer = disposableStub({
      // oxlint-disable-next-line unicorn/no-thenable
      then(onFulfilled: () => void) {
        void heldOpen.promise.then(onFulfilled)
      },
    }) as unknown as RpcStub<Overseer>
    const apiA = {
      openGadget: () => parkedOverseer,
      whoami: async () => WHOAMI_USER,
    } as unknown as RpcStub<AuthenticatedApi>
    const OTHER_USER = { type: 'user', id: 'other@example.com', name: 'Other' }
    const apiB = {
      openGadget: () => openDeniedOverseer(),
      whoami: async () => OTHER_USER,
    } as unknown as RpcStub<AuthenticatedApi>

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
    await act(async () => root!.render(<Probe authenticatedApi={apiA} />))

    // B captures the same key on the swapped stub; the denied open leaves it retained and
    // stamped under B's identity.
    window.location.hash = '#share=aaaa'
    await act(async () => root!.render(<Probe authenticatedApi={apiB} />))
    expect(storedRetained()).toMatchObject({ key: 'aaaa', userId: OTHER_USER.id })

    // A's parked open resolves after A was superseded: B's same-key retention must survive.
    await act(async () => { heldOpen.resolve(); await Promise.resolve() })
    expect(storedRetained()).toMatchObject({ key: 'aaaa', userId: OTHER_USER.id })
  })

  it('a superseded confirmed open cannot resurrect its key over a newer capture', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // Attempt A captures its key with both the open and the identity stamp parked. B (a swapped
    // stub, another user) captures its own key, whose stamp lands and occupies the entry. A's
    // open then confirms: its key-scoped clear rightly leaves B's different-key entry alone --
    // but it must still void A's *own* in-flight stamp, or that stamp lands last and overwrites
    // B's entry with A's server-confirmed key, which a later mount would replay and silently
    // re-redeem after an owner removal.
    window.location.hash = '#share=aaaa'
    const heldOpen = deferred<void>()
    const parkedOverseer = disposableStub({
      // oxlint-disable-next-line unicorn/no-thenable
      then(onFulfilled: () => void) {
        void heldOpen.promise.then(onFulfilled)
      },
    }) as unknown as RpcStub<Overseer>
    const heldWhoami = deferred<typeof WHOAMI_USER>()
    const apiA = {
      openGadget: () => parkedOverseer,
      whoami: () => heldWhoami.promise,
    } as unknown as RpcStub<AuthenticatedApi>
    const OTHER_USER = { type: 'user', id: 'other@example.com', name: 'Other' }
    const apiB = {
      openGadget: () => openDeniedOverseer(),
      whoami: async () => OTHER_USER,
    } as unknown as RpcStub<AuthenticatedApi>

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
    await act(async () => root!.render(<Probe authenticatedApi={apiA} />))

    // B captures its own key on the swapped stub; its stamp lands and owns the entry.
    window.location.hash = '#share=bbbb'
    await act(async () => root!.render(<Probe authenticatedApi={apiB} />))
    expect(storedRetained()).toMatchObject({ key: 'bbbb', userId: OTHER_USER.id })

    // A's open confirms after A was superseded: its clear no-ops on B's entry but voids A's own
    // pending stamp...
    await act(async () => { heldOpen.resolve(); await Promise.resolve() })
    expect(storedRetained()).toMatchObject({ key: 'bbbb', userId: OTHER_USER.id })

    // ...so A's identity resolving late cannot resurrect the confirmed key over B's capture.
    await act(async () => { heldWhoami.resolve(WHOAMI_USER); await Promise.resolve() })
    expect(storedRetained()).toMatchObject({ key: 'bbbb', userId: OTHER_USER.id })
  })

  it('a keyed open that confirms after cancellation clears its own retention', async () => {
    // The complement of the superseded-attempt test above: the open *resolving* proves the server
    // durably confirmed the redemption (nothing in disposal reverts it), so a cancelled attempt
    // with no newer capture in the slot must still discard its own retention -- including
    // voiding its identity stamp still in flight -- or every replay path (a later mount's
    // sessionStorage read, most directly) silently re-redeems the still-live link after an owner
    // removal.
    window.location.hash = '#share=aaaa'
    const heldOpen = deferred<void>()
    const parkedOverseer = disposableStub({
      // oxlint-disable-next-line unicorn/no-thenable
      then(onFulfilled: () => void) {
        void heldOpen.promise.then(onFulfilled)
      },
    }) as unknown as RpcStub<Overseer>
    const heldWhoami = deferred<typeof WHOAMI_USER>()
    const authenticatedApi = {
      openGadget: () => parkedOverseer,
      whoami: () => heldWhoami.promise,
    } as unknown as RpcStub<AuthenticatedApi>

    function Probe() {
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
    await act(async () => root!.render(<Probe />))

    // Unmount cancels the attempt while both its open and its identity stamp are still parked.
    act(() => root!.unmount())
    root = undefined

    // The open confirms after the cancellation: retention must be discarded anyway.
    await act(async () => { heldOpen.resolve(); await Promise.resolve() })
    expect(sessionStorage.getItem(RETAINED_V2_KEY)).toBeNull()

    // ...and the late-landing stamp must not resurrect it (the clear voided the write token), or
    // a fresh mount would replay the confirmed key from storage.
    await act(async () => { heldWhoami.resolve(WHOAMI_USER); await Promise.resolve() })
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
