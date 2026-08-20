import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import { ActionLogEntry, ActionsSubscriber, Overseer } from '@gadgets/workshop-shared/api'

// One ref-counted store per Overseer stub, shared across consumers. Opening a store subscribes
// live-only (no history replay) and then pages a bounded scanPendingActions() loop to find
// records that were already pending. The subscription is initiated first — calls on one stub are
// delivered in order, so the DB subscriber registers server-side before the scan reads anything —
// and any scanned record already delivered live is dropped (live wins: a scanned page can be
// stale by the time it arrives).

export type ActionsState = {
  /**
   * 'checking' while the pending scan is still paging; 'error' if the subscription or scan
   * failed (pendingById keeps whatever was gathered).
   */
  status: 'checking' | 'ready' | 'error'

  /** Pending-review records found so far. */
  pendingById: ReadonlyMap<number, ActionLogEntry>

  /** Every record received live this session (adds and updates, at their latest state). */
  liveById: ReadonlyMap<number, ActionLogEntry>
}

type Store = {
  // Immutable object handed to useSyncExternalStore; rebuilt from the staged fields on commit.
  snapshot: ActionsState
  stagedStatus: ActionsState['status']
  stagedPending: Map<number, ActionLogEntry>
  stagedLive: Map<number, ActionLogEntry>
  liveSeenIds: Set<number>
  refCount: number
  listeners: Set<() => void>
  entryListeners: Set<(record: ActionLogEntry) => void>
  subscription: RpcStub<{}> | null
  generation: number
  notifyScheduled: boolean
}

const EMPTY_STATE: ActionsState = {
  status: 'checking',
  pendingById: new Map(),
  liveById: new Map(),
}

const stores = new WeakMap<RpcStub<Overseer>, Store>()

function getStore(overseer: RpcStub<Overseer>): Store {
  let store = stores.get(overseer)
  if (!store) {
    store = {
      snapshot: EMPTY_STATE,
      stagedStatus: 'checking',
      stagedPending: new Map(),
      stagedLive: new Map(),
      liveSeenIds: new Set(),
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

function commit(store: Store) {
  store.snapshot = {
    status: store.stagedStatus,
    pendingById: new Map(store.stagedPending),
    liveById: new Map(store.stagedLive),
  }
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

function openSubscription(overseer: RpcStub<Overseer>, store: Store) {
  const generation = ++store.generation
  store.stagedStatus = 'checking'
  store.stagedPending = new Map()
  store.stagedLive = new Map()
  store.liveSeenIds = new Set()
  store.snapshot = EMPTY_STATE

  class ActionsSubscriberImpl extends RpcTarget implements ActionsSubscriber {
    entry(record: ActionLogEntry): void {
      if (store.generation !== generation) return
      store.liveSeenIds.add(record.id)
      store.stagedLive.set(record.id, record)
      if (record.state === 'pending') store.stagedPending.set(record.id, record)
      else store.stagedPending.delete(record.id)
      scheduleNotify(store)
      for (const listener of store.entryListeners) listener(record)
    }

    // Settledness is signalled by the scan finishing, not by the subscription.
    ready(): void {}
  }

  const fail = (err: unknown) => {
    if (store.generation !== generation) return
    console.error('Failed to load pending actions:', err)
    store.stagedStatus = 'error'
    commit(store)
  }

  overseer.subscribeToActions(
    new ActionsSubscriberImpl() as unknown as RpcStub<ActionsSubscriber>,
  ).then(sub => {
    if (store.generation !== generation) {
      sub[Symbol.dispose]()
      return
    }
    store.subscription = sub
  }, fail)

  // One scan page in flight at a time; the first page fixes the scan's upper bound, so records
  // created after this point arrive via the subscription only.
  ;(async () => {
    let page = await overseer.scanPendingActions()
    for (;;) {
      if (store.generation !== generation) return
      for (const record of page.entries) {
        if (!store.liveSeenIds.has(record.id)) store.stagedPending.set(record.id, record)
      }
      if (page.nextCursor === undefined) break
      scheduleNotify(store)
      page = await overseer.scanPendingActions(
        { cursor: page.nextCursor, throughId: page.throughId })
    }
    store.stagedStatus = 'ready'
    commit(store)
  })().catch(fail)
}

function closeSubscription(store: Store) {
  store.generation++
  store.subscription?.[Symbol.dispose]()
  store.subscription = null
  store.stagedStatus = 'checking'
  store.stagedPending = new Map()
  store.stagedLive = new Map()
  store.liveSeenIds = new Set()
  store.snapshot = EMPTY_STATE
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
 * Per-entry callback variant. Fires once per live update; on mount it replays the records already
 * received live this session (only those — scan-found pendings don't fan out here). That covers
 * patching content fetched over the same stub: anything fetched reflects the log at fetch time,
 * and everything that changed since arrived live.
 */
export function useActionEntries(
  overseer: RpcStub<Overseer> | null,
  onEntry: (record: ActionLogEntry) => void,
): void {
  // Stable listener identity; latest callback read via ref so updating
  // `onEntry` doesn't resubscribe.
  const callbackRef = useRef(onEntry)
  callbackRef.current = onEntry
  const [stableListener] = useState(() => (record: ActionLogEntry) => {
    callbackRef.current(record)
  })

  useEffect(() => {
    if (!overseer) return
    const store = acquire(overseer)
    store.entryListeners.add(stableListener)

    // Retained until `release()` drops refCount to 0 and deletes the store, so late
    // consumers can replay live-received entries while a shared subscription is still alive.
    for (const record of store.stagedLive.values()) {
      stableListener(record)
    }

    return () => {
      const s = stores.get(overseer)
      s?.entryListeners.delete(stableListener)
      release(overseer)
    }
  }, [overseer, stableListener])
}
