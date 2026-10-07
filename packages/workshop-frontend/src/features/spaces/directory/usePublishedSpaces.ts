import { useEffect, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, PublishedSpaceInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../../AuthContext'
import { useUiFeatureFlag } from '../../../FeatureFlagsContext'
import { logRpcFailure } from '../../../rpcErrors'

/** How long typing has to pause before the directory is searched. */
export const SEARCH_DEBOUNCE_MS = 250

/** The longest query `AuthenticatedApi.listPublishedSpaces` accepts. */
const MAX_QUERY_LENGTH = 1000

/**
 * `text` as the directory is asked for it: on one line, without surrounding whitespace, and no
 * longer than the server accepts, which refuses a query with a line break or over its limit.
 */
export const directoryQuery = (text: string): string =>
  text.replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_QUERY_LENGTH).trimEnd()

/**
 * The directory as last read for one query.
 *
 * - `loading`: its first page has not arrived.
 * - `failed`: its first page could not be read; `refresh` reads it again.
 * - `ready`: the pages read so far, in the directory's order. `cursor` is present while there is
 *   another page, and `more` says how reading it went.
 */
export type PublishedSpacesState =
  | { status: 'loading' }
  | { status: 'failed'; query: string }
  | {
    status: 'ready'
    query: string
    spaces: PublishedSpaceInfo[]
    cursor?: string
    more: 'idle' | 'loading' | 'failed'
  }

/** What `usePublishedSpaces` returns. */
export type PublishedSpaces = {
  /** The directory for `state.query`, which trails the query typed while `searching`. */
  state: PublishedSpacesState
  /**
   * What is shown answers an earlier query, or an earlier read, than the latest one: the typed
   * query is still settling, or a first page is on its way.
   */
  searching: boolean
  /** Reads the next page and appends it. Does nothing without a cursor, or while one is read. */
  loadMore: () => void
  /** Reads the directory again from its first page, leaving what is shown until that arrives. */
  refresh: () => void
}

const LOADING: PublishedSpacesState = { status: 'loading' }

// One read of the directory from its first page: a new search, or the same one read again, is a
// new object even for the same query.
type Search = { query: string }

type Shown = {
  api: RpcStub<AuthenticatedApi>
  // The search this state answers: a page read for an earlier one is dropped.
  search: Search
  state: Exclude<PublishedSpacesState, { status: 'loading' }>
}

/**
 * The spaces of the directory (`AuthenticatedApi.listPublishedSpaces`) that match `query`, read
 * page by page. The query is searched once typing pauses, trimmed and on one line; an earlier
 * query's results stay shown until the new one's first page arrives, and a response to a query
 * or read that has since been replaced is dropped, whenever it arrives.
 *
 * Like `useSpaces`, the hook asks a session for nothing before that session's own flags say the
 * `spaces` flag is on.
 */
export const usePublishedSpaces = (query: string): PublishedSpaces => {
  const { authenticatedApi } = useAuthenticatedApi()
  const { enabled } = useUiFeatureFlag('spaces')
  const typed = directoryQuery(query)
  const [search, setSearch] = useState<Search>(() => ({ query: typed }))
  const [shown, setShown] = useState<Shown | null>(null)

  useEffect(() => {
    if (typed === search.query) return
    const timer = window.setTimeout(() => setSearch({ query: typed }), SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [typed, search])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    const { query: searched } = search
    const settle = (state: Shown['state']) => {
      if (!cancelled) setShown({ api: authenticatedApi, search, state })
    }
    authenticatedApi.listPublishedSpaces(searched || undefined).then(
      page => settle({ status: 'ready', query: searched, ...page, more: 'idle' }),
      err => {
        logRpcFailure('Failed to list published spaces:', err)
        settle({ status: 'failed', query: searched })
      })
    return () => { cancelled = true }
  }, [authenticatedApi, enabled, search])

  const current = shown?.api === authenticatedApi ? shown : null

  const loadMore = () => {
    if (current?.state.status !== 'ready') return
    const { state, search: continued } = current
    const { cursor } = state
    if (cursor === undefined || state.more === 'loading') return
    // Only the state this page continues takes it: a later read, a read in another session, or
    // a page already appended from a second call made before this one rendered, has moved on.
    const update = (next: (state: Extract<Shown['state'], { status: 'ready' }>) => Shown['state']) =>
      setShown(previous =>
        previous && previous.api === authenticatedApi && previous.search === continued
          && previous.state.status === 'ready'
          && previous.state.cursor === cursor
          ? { ...previous, state: next(previous.state) }
          : previous)
    update(ready => ({ ...ready, more: 'loading' }))
    authenticatedApi.listPublishedSpaces(state.query || undefined, cursor).then(
      page => update(ready => {
        // The directory is read in pages of an order that may change between them: a space
        // renamed meanwhile can come back on a later page.
        const listed = new Set(ready.spaces.map(space => space.key))
        return {
          ...ready,
          spaces: [...ready.spaces, ...page.spaces.filter(space => !listed.has(space.key))],
          cursor: page.cursor,
          more: 'idle',
        }
      }),
      err => {
        logRpcFailure('Failed to list more published spaces:', err)
        update(ready => ({ ...ready, more: 'failed' }))
      })
  }

  return {
    state: current?.state ?? LOADING,
    searching: current !== null && (current.search !== search || search.query !== typed),
    loadMore,
    refresh: () => setSearch(latest => ({ query: latest.query })),
  }
}
