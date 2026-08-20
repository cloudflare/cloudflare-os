import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { ActionHistoryFilter, ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { useActionEntries } from './useActions'

export type ActionHistoryStatus = 'idle' | 'loading' | 'ready' | 'error'

type View = {
  byId: ReadonlyMap<number, ActionLogEntry>
  status: ActionHistoryStatus
  hasMore: boolean
  isLoadingMore: boolean
}

const INITIAL: View = { byId: new Map(), status: 'idle', hasMore: true, isLoadingMore: false }

/**
 * Demand-loads resolved action history, one page at a time, newest first by id (creation order).
 * Nothing is fetched until `active` first becomes true; `loadMore()` continues from the server
 * cursor. A server page may be short or even empty while older history remains (the backend caps
 * raw records examined), so `hasMore` — not entry count — is the termination signal. The overseer
 * stub or filter changing resets everything (a reconnect hands out a fresh stub).
 *
 * Live updates from the shared action subscription are merged in: a resolved, filter-matching
 * record patches in place or inserts if it falls inside the loaded id window. Records below the
 * window are dropped — they surface, read fresh, when their page loads.
 */
export function useActionHistory(
  overseer: RpcStub<Overseer> | null,
  filter: ActionHistoryFilter,
  active: boolean,
) {
  const [view, setView] = useState<View>(INITIAL)
  // Paging bookkeeping lives outside render state so pages chain without stale-closure hazards.
  // `frontier` is the next page's beforeId; undefined once `exhausted` (or before the first page).
  const sessionRef = useRef({
    generation: 0, frontier: undefined as number | undefined,
    started: false, inFlight: false, exhausted: false, pages: 0,
  })

  useEffect(() => {
    sessionRef.current = {
      generation: sessionRef.current.generation + 1, frontier: undefined,
      started: false, inFlight: false, exhausted: false, pages: 0,
    }
    setView(INITIAL)
  }, [overseer, filter])

  const loadMore = useCallback(() => {
    const session = sessionRef.current
    if (!overseer || session.inFlight || session.exhausted) return
    const { generation } = session
    const first = !session.started
    session.started = true
    session.inFlight = true
    setView(prev => first ? { ...prev, status: 'loading' } : { ...prev, isLoadingMore: true })

    overseer.listActions({ beforeId: session.frontier, filter }).then(page => {
      if (sessionRef.current.generation !== generation) return
      session.inFlight = false
      session.frontier = page.nextBeforeId
      session.exhausted = page.nextBeforeId === undefined
      session.pages++
      setView(prev => {
        const byId = new Map(prev.byId)
        for (const record of page.entries) byId.set(record.id, record)
        return { byId, status: 'ready', hasMore: !session.exhausted, isLoadingMore: false }
      })
    }, (err: unknown) => {
      if (sessionRef.current.generation !== generation) return
      session.inFlight = false
      if (first) session.started = false  // let the next loadMore() retry as a first load
      console.error('Failed to load action history:', err)
      setView(prev => ({
        ...prev,
        status: first ? 'error' : prev.status,
        isLoadingMore: false,
      }))
    })
  }, [overseer, filter])

  useEffect(() => {
    if (active && !sessionRef.current.started) loadMore()
  }, [active, loadMore])

  useActionEntries(overseer, record => {
    const session = sessionRef.current
    if (session.pages === 0) return
    if (record.state === 'pending') return
    if (filter !== 'all' && record.type !== filter) return
    if (session.frontier !== undefined && record.id < session.frontier) return
    setView(prev => {
      const byId = new Map(prev.byId)
      byId.set(record.id, record)
      return { ...prev, byId }
    })
  })

  const entries = useMemo(
    () => [...view.byId.values()].toSorted((a, b) => b.id - a.id),
    [view.byId])

  return {
    entries,
    status: view.status,
    hasMore: view.hasMore,
    isLoadingMore: view.isLoadingMore,
    loadedCount: entries.length,
    loadMore,
  }
}
