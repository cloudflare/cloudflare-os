import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import { matchesActionHistoryFilter } from '@gadgets/workshop-shared/api'
import type { ActionHistoryFilter, ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'
import { actionLogResumed, useActionEntries } from './useActions'

export type ActionHistoryStatus = 'loading' | 'ready' | 'error'

/**
 * The filters this hook pages: everything but "pending", whose live set is useActions' job. The
 * live-merge below leans on the exclusion — against the remaining filters a record never stops
 * matching (type never changes, and resolving only moves a record out of "pending"), so updates
 * failing the filter can be ignored rather than needing removal.
 */
export type HistoryViewFilter = Exclude<ActionHistoryFilter, 'pending'>

type HistoryState = {
  byId: ReadonlyMap<number, ActionLogEntry>
  // 'initial' = the first page failed (surfaces as status 'error'); 'more' = a loadMore failed.
  error: 'initial' | 'more' | null
}

type HistorySession = {
  frontier: number | undefined
  inFlight: boolean
  hasLoadedPage: boolean
}

function createHistorySession(): HistorySession {
  return { frontier: undefined, inFlight: false, hasLoadedPage: false }
}

const INITIAL: HistoryState = { byId: new Map(), error: null }

/**
 * Demand-loads action history (pending records included), one page at a time, newest first by id
 * (creation order). Nothing is fetched until `active` first becomes true; `loadMore()` continues
 * from the server cursor, and `hasMore` is the termination signal. The filter changing resets
 * everything; so does the overseer stub changing (a reconnect hands out a fresh stub), unless
 * the shared store resumed — then the loaded window and cursor survive the swap.
 *
 * Live updates from the shared action subscription are merged in: a filter-matching record —
 * a fresh pending one or a resolution — patches in place or inserts if it falls inside the
 * loaded id window. Records below the window are dropped — they surface, read fresh, when their
 * page loads.
 */
export function useActionHistory(
  overseer: RpcStub<Overseer> | null,
  filter: HistoryViewFilter,
  active: boolean,
) {
  const [state, setState] = useState<HistoryState>(INITIAL)
  // The request-identity token, mutated in place. `frontier` is undefined before the first page
  // and after the terminal page; `hasLoadedPage` distinguishes those states. The returned
  // status/hasMore/isLoadingMore are derived from it at the return site, which is safe because
  // every mutation of it is paired with a setState (so a render always follows).
  const sessionRef = useRef(createHistorySession())

  useEffect(() => {
    sessionRef.current = createHistorySession()
    setState(INITIAL)
  }, [filter])

  const loadMore = useCallback(() => {
    const session = sessionRef.current
    if (!overseer || session.inFlight ||
        (session.hasLoadedPage && session.frontier === undefined)) return
    const first = !session.hasLoadedPage
    session.inFlight = true
    setState(prev => ({ ...prev, error: null }))

    overseer.listActions({ beforeId: session.frontier, filter }).then(page => {
      if (sessionRef.current !== session) return
      session.inFlight = false
      session.hasLoadedPage = true
      session.frontier = page.nextBeforeId
      setState(prev => {
        const byId = new Map(prev.byId)
        for (const record of page.entries) byId.set(record.id, record)
        return { byId, error: null }
      })
    }, (err: unknown) => {
      if (sessionRef.current !== session) return
      session.inFlight = false
      console.error('Failed to load action history:', err)
      setState(prev => ({ ...prev, error: first ? 'initial' : 'more' }))
    })
  }, [overseer, filter])

  // Registered before the initial-load effect below: mounting the shared store initiates its
  // subscribeToActions, and effects run in declaration order, so capnweb e-order registers the
  // subscriber server-side before the first page's listActions reads (the subscribe-before-query
  // contract, see api.ts). Otherwise a record resolved between the two would be missed by both.
  useActionEntries(overseer, record => {
    const session = sessionRef.current
    // Dropping records here can't lose an update: listActions snapshots and responds in one DO
    // turn, so on the ordered RPC session an entry reflecting a post-snapshot change always
    // arrives after the page it would race with. Anything dropped pre-first-page or below the
    // frontier is state a loaded page already supersedes, or is read fresh when its page loads.
    if (!session.hasLoadedPage) return
    if (!matchesActionHistoryFilter(record, filter)) return
    if (session.frontier !== undefined && record.id < session.frontier) return
    setState(prev => {
      const byId = new Map(prev.byId)
      byId.set(record.id, record)
      return { ...prev, byId }
    })
  })

  // A stub swap resets everything — unless the shared store resumed, in which case the gap was
  // replayed through the subscription above: keep the window and the frontier (a server-stable
  // id cursor), rebuilding the session token so any in-flight old-stub page is dropped. Ordering
  // matters: after useActionEntries (which creates the store, setting its resumed flag), and
  // before the initial-load effect (so a reset refetches).
  const prevOverseerRef = useRef(overseer)
  useEffect(() => {
    if (prevOverseerRef.current === overseer) return
    prevOverseerRef.current = overseer
    if (actionLogResumed(overseer)) {
      const { frontier, hasLoadedPage } = sessionRef.current
      sessionRef.current = { frontier, inFlight: false, hasLoadedPage }
      setState(prev => ({ ...prev, error: null }))
    } else {
      sessionRef.current = createHistorySession()
      setState(INITIAL)
    }
  }, [overseer])

  useEffect(() => {
    if (active && !sessionRef.current.hasLoadedPage) loadMore()
  }, [active, loadMore])

  const entries = useMemo(
    () => Array.from(state.byId.values()).sort((a, b) => b.id - a.id),
    [state.byId])

  const session = sessionRef.current
  return {
    entries,
    // 'loading' from the start: nothing is fetched until `active`, but the panel isn't visible
    // (and the status unread) until then either, and the first fetch follows immediately.
    status: (state.error === 'initial' ? 'error'
        : session.hasLoadedPage ? 'ready' : 'loading') satisfies ActionHistoryStatus,
    hasMore: session.frontier !== undefined,
    isLoadingMore: session.inFlight && session.hasLoadedPage,
    loadMoreFailed: state.error === 'more',
    loadMore,
  }
}
