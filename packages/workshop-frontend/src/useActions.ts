import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import { ActionLogEntry, ActionsSubscriber, Overseer } from '@gadgets/workshop-shared/api'

// One ref-counted store per Overseer stub, shared across consumers. On open the store initiates
// the live subscription first, then pages the currently-pending set via
// listActions({filter: 'pending'}): capnweb e-order registers the subscriber server-side before
// the first page reads, so every record is covered — pages snapshot call-time state, and
// everything that changes after arrives on the subscription. Pages fold with live-wins
// semantics; the last page loading is the "settled" signal. Resolved history is demand-paged
// separately (see useActionHistory).

export type ActionsState = {
  /**
   * 'checking' until the subscription is registered and the last pending page has loaded;
   * 'error' if either failed (`pending` keeps whatever was gathered).
   */
  status: 'checking' | 'ready' | 'error'

  /** Pending-review records found so far, oldest first (createdAt, then id). */
  pending: readonly ActionLogEntry[]
}

type Store = {
  // Immutable object handed to useSyncExternalStore; rebuilt from the staged fields on commit.
  snapshot: ActionsState
  stagedPending: Map<number, ActionLogEntry>
  // Records delivered on the live subscription (only — paged records are not entries), retained
  // for useActionEntries' mount-time replay.
  stagedEntries: Map<number, ActionLogEntry>
  refCount: number
  listeners: Set<() => void>
  entryListeners: Set<(record: ActionLogEntry) => void>
  subscription: RpcStub<{}> | null
  generation: number
  notifyScheduled: boolean
}

const EMPTY_STATE: ActionsState = {
  status: 'checking',
  pending: [],
}

const stores = new WeakMap<RpcStub<Overseer>, Store>()

function getStore(overseer: RpcStub<Overseer>): Store {
  let store = stores.get(overseer)
  if (!store) {
    store = {
      snapshot: EMPTY_STATE,
      stagedPending: new Map(),
      stagedEntries: new Map(),
      refCount: 0,
      listeners: new Set(),
      entryListeners: new Set(),
      subscription: null,
      generation: 0,
      notifyScheduled: false,
    }
    stores.set(overseer, store)
  }
  return store
}

function commit(store: Store, status: ActionsState['status'] = store.snapshot.status): void {
  // Entries arrive in ascending id order, so this sort is near-free at pending-count scale.
  const pending = [...store.stagedPending.values()].toSorted((a, b) =>
    a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)
  store.snapshot = { status, pending }
  for (const listener of store.listeners) listener()
}

// Coalesce bursts of entries into one snapshot per frame. Status transitions commit synchronously
// instead (see openSubscription) so a throttled background tab still settles.
function scheduleNotify(store: Store) {
  if (store.notifyScheduled) return
  store.notifyScheduled = true

  window.requestAnimationFrame(() => {
    store.notifyScheduled = false
    commit(store)
  })
}

// Bumps the generation (orphaning any in-flight callbacks) and clears the staged session state.
function resetSession(store: Store): number {
  store.generation++
  store.stagedPending = new Map()
  store.stagedEntries = new Map()
  store.snapshot = EMPTY_STATE
  return store.generation
}

function openSubscription(overseer: RpcStub<Overseer>, store: Store) {
  const generation = resetSession(store)

  class ActionsSubscriberImpl extends RpcTarget implements ActionsSubscriber {
    entry(record: ActionLogEntry): void {
      if (store.generation !== generation) return
      store.stagedEntries.set(record.id, record)
      let pendingChanged: boolean
      if (record.state === 'pending') {
        store.stagedPending.set(record.id, record)
        pendingChanged = true
      } else {
        pendingChanged = store.stagedPending.delete(record.id)
      }
      // Entries that never touch the pending set (observations, hook events) don't need a
      // re-sorted snapshot or a consumer re-render.
      if (pendingChanged) scheduleNotify(store)
      for (const listener of store.entryListeners) {
        try {
          listener(record)
        } catch (err) {
          console.error('Action entry listener failed:', err)
        }
      }
    }

    // Settledness is signalled by the pending page loop draining, not by the subscription.
    ready(): void {}
  }

  let failed = false
  const fail = (error: unknown) => {
    if (store.generation !== generation) return
    console.error('Failed to load pending actions:', error)
    // Deliberately also downgrades an already-'ready' store: the pages can drain before the
    // subscribe call's return trip fails, and a store with a dead live stream must not present
    // as settled.
    failed = true
    commit(store, 'error')
  }

  // Initiated first — the page loop below relies on capnweb e-order having registered the
  // subscriber server-side before the first page reads.
  overseer.subscribeToActions(
    new ActionsSubscriberImpl() as unknown as RpcStub<ActionsSubscriber>,
  ).then(sub => {
    if (store.generation !== generation) {
      sub[Symbol.dispose]()
      return
    }
    store.subscription = sub
  }, fail)

  // One page in flight at a time. Records created mid-paging are live-only (their ids are above
  // page 1's snapshot bound), so the fold only has to resolve one conflict class: a page's stale
  // copy of a record the subscription already delivered — the subscription's copy (in any state)
  // is newer by definition, so a record resolved live is never re-marked pending by a page that
  // predates the resolution.
  ;(async () => {
    let beforeId: number | undefined
    do {
      const page = await overseer.listActions({ filter: 'pending', beforeId })
      if (store.generation !== generation) return
      for (const record of page.entries) {
        if (!store.stagedEntries.has(record.id)) store.stagedPending.set(record.id, record)
      }
      beforeId = page.nextBeforeId
      scheduleNotify(store)
    } while (beforeId !== undefined)
    // Synchronous commit (not scheduleNotify) so a throttled background tab still settles. A
    // subscribe failure is sticky: pages draining afterwards must not upgrade a store whose live
    // stream is dead back to 'ready'.
    commit(store, failed ? 'error' : 'ready')
  })().catch(fail)
}

function closeSubscription(store: Store) {
  resetSession(store)
  store.subscription?.[Symbol.dispose]()
  store.subscription = null
}

function acquire(overseer: RpcStub<Overseer>): Store {
  const store = getStore(overseer)
  store.refCount++
  if (store.refCount === 1) {
    openSubscription(overseer, store)
  }
  return store
}

function release(overseer: RpcStub<Overseer>) {
  const store = stores.get(overseer)
  if (!store) return
  store.refCount--
  if (store.refCount <= 0) {
    closeSubscription(store)
    stores.delete(overseer)
  }
}

/** Subscribe to the gadget's action log. Pass `null` to no-op ('checking', empty maps). */
export function useActions(overseer: RpcStub<Overseer> | null): ActionsState {
  useEffect(() => {
    if (!overseer) return
    acquire(overseer)
    return () => release(overseer)
  }, [overseer])

  const subscribe = useCallback((cb: () => void) => {
    if (!overseer) return () => {}
    const store = getStore(overseer)
    store.listeners.add(cb)
    return () => { store.listeners.delete(cb) }
  }, [overseer])
  const getSnapshot = useCallback(() => {
    if (!overseer) return EMPTY_STATE
    return stores.get(overseer)?.snapshot ?? EMPTY_STATE
  }, [overseer])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Per-entry callback variant. Fires once per entry delivered on the live subscription (paged
 * pending records are not entries); on mount it replays the records already received this
 * session. That covers patching content fetched over the same stub: anything fetched reflects
 * the log at fetch time, and everything that changed since arrived through the stream.
 */
export function useActionEntries(
  overseer: RpcStub<Overseer> | null,
  onEntry: (record: ActionLogEntry) => void,
): void {
  const callbackRef = useRef(onEntry)
  callbackRef.current = onEntry

  useEffect(() => {
    if (!overseer) return

    function listener(record: ActionLogEntry): void {
      callbackRef.current(record)
    }

    const store = acquire(overseer)
    store.entryListeners.add(listener)

    // Retained until `release()` drops refCount to 0 and deletes the store, so late
    // consumers can replay already-received entries while a shared subscription is still alive.
    for (const record of store.stagedEntries.values()) {
      listener(record)
    }

    return () => {
      const s = stores.get(overseer)
      s?.entryListeners.delete(listener)
      release(overseer)
    }
  }, [overseer])
}
