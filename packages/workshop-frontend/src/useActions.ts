import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { RpcStub, RpcTarget } from 'capnweb'
import { ActionLogEntry, ActionsSubscriber, Overseer } from '@gadgets/workshop-shared/api'

// One ref-counted subscription per Overseer stub, shared across consumers.
// `startAfter: epoch 0` asks the backend to replay full history through the
// subscriber, avoiding a stale-state race against a separate `listActions()`.

type Store = {
  actionsById: Map<number, ActionLogEntry>
  pendingActionsById: Map<number, ActionLogEntry>
  isReady: boolean
  refCount: number
  listeners: Set<() => void>
  entryListeners: Set<(record: ActionLogEntry) => void>
  subscription: RpcStub<{}> | null
  generation: number
  notifyScheduled: boolean
}

const stores = new WeakMap<RpcStub<Overseer>, Store>()

function getStore(overseer: RpcStub<Overseer>): Store {
  let store = stores.get(overseer)
  if (!store) {
    store = {
      actionsById: new Map(),
      pendingActionsById: new Map(),
      isReady: false,
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

function notify(store: Store) {
  for (const listener of store.listeners) listener()
}

function scheduleNotify(store: Store) {
  if (store.notifyScheduled) return
  store.notifyScheduled = true

  window.requestAnimationFrame(() => {
    store.notifyScheduled = false
    store.actionsById = new Map(store.pendingActionsById)
    notify(store)
  })
}

function openSubscription(overseer: RpcStub<Overseer>, store: Store) {
  const generation = ++store.generation
  store.actionsById = new Map()
  store.pendingActionsById = new Map()
  store.isReady = false

  class ActionsSubscriberImpl extends RpcTarget implements ActionsSubscriber {
    entry(record: ActionLogEntry): void {
      if (store.generation !== generation) return
      store.pendingActionsById.set(record.id, record)
      scheduleNotify(store)
      for (const listener of store.entryListeners) listener(record)
    }

    ready(): void {
      if (store.generation !== generation) return
      store.actionsById = new Map(store.pendingActionsById)
      store.isReady = true
      notify(store)
    }
  }

  ;(async () => {
    try {
      const sub = await overseer.subscribeToActions(
        new ActionsSubscriberImpl() as unknown as RpcStub<ActionsSubscriber>,
        new Date(0),
      )
      if (store.generation !== generation) {
        sub[Symbol.dispose]()
        return
      }
      store.subscription = sub
    } catch (err) {
      if (store.generation === generation) {
        store.isReady = true
        notify(store)
        console.error('Failed to subscribe to actions:', err)
      }
    }
  })()
}

function closeSubscription(store: Store) {
  store.generation++
  store.subscription?.[Symbol.dispose]()
  store.subscription = null
  store.actionsById = new Map()
  store.pendingActionsById = new Map()
  store.isReady = false
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

/**
 * Earlier pending actions from the same gatekeeper connection that approving `record` would also
 * apply: the backend treats an approval as a decision frontier covering everything before it.
 */
export function countEarlierPending(
  entries: Iterable<ActionLogEntry>,
  record: ActionLogEntry,
): number {
  if (record.type !== 'action' || record.gatekeeperId === undefined) return 0
  let count = 0
  for (const other of entries) {
    if (
      other.type === 'action' &&
      other.state === 'pending' &&
      other.gatekeeperId === record.gatekeeperId &&
      other.id < record.id
    ) {
      count++
    }
  }
  return count
}

/**
 * Display note for a rejection that cascaded from another action's veto, naming the vetoed action
 * when it is still in the local list.
 */
export function invalidationNote(
  record: ActionLogEntry,
  actionsById: Map<number, ActionLogEntry>,
): string | undefined {
  if (record.type !== 'action' || record.state !== 'rejected' || record.cascadedFrom === undefined) {
    return undefined
  }
  const source = actionsById.get(record.cascadedFrom)
  return source?.type === 'action'
    ? `Invalidated by rejection of “${source.description.title}”`
    : 'Invalidated by a rejected action'
}

export type UseActionsResult = {
  actionsById: Map<number, ActionLogEntry>
  isReady: boolean
}

const EMPTY_MAP: Map<number, ActionLogEntry> = new Map()

/** Subscribe to the gadget's action log. Pass `null` to no-op. */
export function useActions(overseer: RpcStub<Overseer> | null): UseActionsResult {
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
    if (!overseer) return EMPTY_MAP
    return stores.get(overseer)?.actionsById ?? EMPTY_MAP
  }, [overseer])
  const getIsReady = useCallback(() => {
    if (!overseer) return false
    return stores.get(overseer)?.isReady ?? false
  }, [overseer])

  const actionsById = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const isReady = useSyncExternalStore(subscribe, getIsReady, getIsReady)

  return { actionsById, isReady }
}

/**
 * Per-entry callback variant. Fires once for every existing action on mount
 * (replay) and once per live update — no separate seeding needed.
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
    // consumers can replay entries while a shared subscription is still alive.
    for (const record of store.pendingActionsById.values()) {
      stableListener(record)
    }

    return () => {
      const s = stores.get(overseer)
      s?.entryListeners.delete(stableListener)
      release(overseer)
    }
  }, [overseer, stableListener])
}
