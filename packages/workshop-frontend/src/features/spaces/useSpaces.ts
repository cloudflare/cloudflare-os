import { useEffect, useState, useSyncExternalStore } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, SpaceInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import { logRpcFailure } from '../../rpcErrors'

/** The signed-in user's spaces, as `useSpaces` reports them. */
export type Spaces = {
  /**
   * The `spaces` UI flag. While it is off nothing is loaded and `spaces` stays empty. A session
   * that has not been told its flags yet reads as the session before it did, and as off when
   * there was none.
   */
  enabled: boolean
  /**
   * The spaces the user is a member of, their own personal space first (see
   * `AuthenticatedApi.listSpaces`). Empty until the first load. A load that fails leaves the last
   * list in place, and so does a session that has not loaded its own yet.
   */
  spaces: SpaceInfo[]
  /** The first load has not finished yet. */
  loading: boolean
  /** The latest load failed. */
  failed: boolean
  /**
   * Loads the list again, resolving once it has settled. Does nothing while the flag is off, or
   * not known yet.
   */
  refresh: () => Promise<void>
}

const NO_SPACES: SpaceInfo[] = []

// `spaces` is the session's own list as last read, or null while no load of it has succeeded.
type Loaded = { spaces: SpaceInfo[] | null; failed: boolean }

type SpacesStore = {
  subscribe: (listener: () => void) => () => void
  /** What the latest load left, or null before any has settled. */
  getLoaded: () => Loaded | null
  /** Starts a load, whatever else is in flight: what a change to the list is followed by. */
  load: () => Promise<void>
  /** The load in flight, or a new one: enough for a reader that has changed nothing. */
  loadOnce: () => Promise<void>
}

// One list per session, shared by every mounted `useSpaces`, so the sidebar and the page beside it
// show the same spaces and a refresh either asks for reaches both. Keyed weakly by the session's
// stub, so a list goes with its session.
const stores = new WeakMap<RpcStub<AuthenticatedApi>, SpacesStore>()

const storeFor = (api: RpcStub<AuthenticatedApi>): SpacesStore => {
  const existing = stores.get(api)
  if (existing) return existing

  const listeners = new Set<() => void>()
  let loaded: Loaded | null = null
  let latest = 0
  let inFlight: Promise<void> | null = null

  const load = () => {
    const request = ++latest
    const settled = (async () => {
      let next: Loaded
      try {
        next = { spaces: await api.listSpaces(), failed: false }
      } catch (err) {
        logRpcFailure('Failed to load spaces:', err)
        next = { spaces: loaded?.spaces ?? null, failed: true }
      }
      if (request !== latest) return
      loaded = next
      inFlight = null
      for (const listener of listeners) listener()
    })()
    inFlight = settled
    return settled
  }

  const store: SpacesStore = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getLoaded: () => loaded,
    load,
    loadOnce: () => inFlight ?? load(),
  }
  stores.set(api, store)
  return store
}

/** `value` while it is `known`, and what it last was while it is not. */
const useLastKnown = <T,>(value: T, known: boolean): T => {
  const [last, setLast] = useState(value)
  if (known && !Object.is(last, value)) setLast(value)
  return known ? value : last
}

/**
 * The signed-in user's spaces: one list for the session, loaded when a component using the hook
 * mounts and again on `refresh`, and the same in every component using it.
 *
 * The hook reads the `spaces` flag itself and makes no call while it is off, because
 * `listSpaces()` is not a plain read: the first call creates the caller's personal space and
 * starts registering their existing workspaces with it.
 *
 * A session that replaces another (a reconnect) has neither its flags nor its list for a moment,
 * and has no list for longer when its first load fails. Until each arrives the hook reports what
 * the session before it had, so that what is on screen under the flag, and what the user chose
 * from the list, is not dropped and then brought back. The new session's own list is still not
 * asked for before its own flags say the flag is on.
 */
export const useSpaces = (): Spaces => {
  const { authenticatedApi } = useAuthenticatedApi()
  const flag = useUiFeatureFlag('spaces')
  const store = storeFor(authenticatedApi)
  const loaded = useSyncExternalStore(store.subscribe, store.getLoaded)
  const enabled = useLastKnown(flag.enabled, !flag.loading)
  const ownSpaces = loaded?.spaces ?? null
  const spaces = useLastKnown(ownSpaces, ownSpaces !== null)
  const failed = useLastKnown(loaded?.failed ?? false, loaded !== null)

  useEffect(() => {
    if (flag.enabled) void store.loadOnce()
  }, [store, flag.enabled])

  return {
    enabled,
    spaces: (enabled ? spaces : null) ?? NO_SPACES,
    // A first load that failed is not loading: it is `failed`, with no list.
    loading: enabled && spaces === null && loaded === null,
    failed: enabled && failed,
    refresh: () => (flag.enabled ? store.load() : Promise.resolve()),
  }
}
