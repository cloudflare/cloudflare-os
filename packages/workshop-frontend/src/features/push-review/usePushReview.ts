import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer, PushReview, PushReviewEntry } from '@gadgets/workshop-shared/api'
import { rpcFailureDescription } from '../../rpcErrors'
import { entryKey, reviewTooLarge, sentObjectCount } from './pushReviewModel'

// How often a read that found the listing changed under it starts over before giving up.
const MAX_RESTARTS = 3

const CHANGED = 'The push changed while it was being read.'

type ReviewState = {
  /** The action these pages are of. */
  actionId: number
  entries: PushReviewEntry[]
  /** The first page's; every later page must agree with it. */
  objectCount: number
  stackedOn: number[]
  /** The cursor of the next page; absent before the first page and after the last. */
  next: number | undefined
  pages: number
  done: boolean
  loading: boolean
  error: string | undefined
  restarts: number
  restarted: boolean
}

const unread = (actionId: number): ReviewState => ({
  actionId, entries: [], objectCount: 0, stackedOn: [], next: undefined, pages: 0, done: false,
  loading: true, error: undefined, restarts: 0, restarted: false,
})

// The cursor counts entries from the start, so pages line up only while the kernel lists the
// same entries. Three things show that it did not: another object count (the push sends other
// objects), an entry already held (entries appeared before the cursor and the rest moved down),
// and, once the last page is in, a listing that names fewer objects than the push sends (an
// object the store lacked arrived, and turned entries after the cursor into entries before it).
// Each drops what was read. What this proves is that every object the push sends is in the
// review once; an entry that sends no object could still go missing, which the kernel rules out
// for a push queued from a workspace that holds restricted data.
const withPage = (state: ReviewState, page: PushReview): ReviewState => {
  const keys = new Set(state.entries.map(entryKey))
  const repeats = page.entries.some(entry => {
    const key = entryKey(entry)
    if (keys.has(key)) return true
    keys.add(key)
    return false
  })
  const entries = [...state.entries, ...page.entries]
  const last = page.next === undefined
  const changed = repeats ||
    (state.pages > 0 && page.objectCount !== state.objectCount) ||
    (last ? sentObjectCount(entries) !== page.objectCount : page.entries.length === 0)
  if (!changed) {
    return {
      ...state, entries, objectCount: page.objectCount, stackedOn: page.stackedOn, next: page.next,
      pages: state.pages + 1, done: last,
    }
  }
  const again = { ...unread(state.actionId), restarted: true }
  return state.restarts < MAX_RESTARTS
    ? { ...again, restarts: state.restarts + 1 }
    : { ...again, loading: false, error: CHANGED }
}

/**
 * What a pending push will send, a page at a time (see Overseer.getPushReview()). The first page
 * is read at once. With `loadAll` the rest follow by themselves for as long as the review is one
 * the dialog loads whole (`reviewTooLarge`); otherwise, and from then on, a page is read on
 * `loadMore()`. `done` is true only when every page is in and they form one consistent listing;
 * `restarted` says the read had to start over to get one. `error` holds a page that failed, which
 * `retry()` reads again.
 */
export const usePushReview = (overseer: RpcStub<Overseer>, actionId: number, loadAll: boolean) => {
  const [stored, setStored] = useState(() => unread(actionId))
  // What the reading loop continues from: the state as last committed, ahead of the render.
  const latest = useRef(stored)
  const commit = (state: ReviewState) => {
    latest.current = state
    setStored(state)
  }
  // Bumped by loadMore() and retry(), which mark the state as loading: the Effect reads on.
  const [request, setRequest] = useState(0)

  useEffect(() => {
    let cancelled = false
    const reads = (state: ReviewState) =>
      state.pages === 0 || (loadAll && !reviewTooLarge(state.entries, state.objectCount))

    let state = latest.current.actionId === actionId ? latest.current : unread(actionId)
    if (!state.loading) {
      // Idle: there is something to read only when `loadAll` came to hold with pages left.
      if (state.done || state.error !== undefined || !reads(state)) return
      state = { ...state, loading: true }
    }
    if (state !== latest.current) commit(state)

    void (async () => {
      for (;;) {
        let page: PushReview
        try {
          page = await overseer.getPushReview(actionId, state.next)
        } catch (error) {
          if (!cancelled) {
            commit({ ...state, loading: false, error: rpcFailureDescription(error) ?? 'The review could not be loaded.' })
          }
          return
        }
        if (cancelled) return
        state = withPage(state, page)
        if (state.done || state.error !== undefined || !reads(state)) {
          commit({ ...state, loading: false })
          return
        }
        commit(state)
      }
    })()
    return () => { cancelled = true }
    // `commit` only writes a ref and a state setter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overseer, actionId, loadAll, request])

  const state = stored.actionId === actionId ? stored : unread(actionId)
  const read = () => {
    commit({ ...state, loading: true, error: undefined })
    setRequest(count => count + 1)
  }
  return {
    entries: state.entries,
    objectCount: state.objectCount,
    stackedOn: state.stackedOn,
    done: state.done,
    loading: state.loading,
    error: state.error,
    restarted: state.restarted,
    /** Reads the next page, when there is one and none is being read. */
    loadMore: () => { if (!state.loading && !state.done && state.error === undefined) read() },
    /** Reads the failed page again, or the whole review when it kept changing. */
    retry: () => { if (state.error !== undefined) read() },
  }
}
