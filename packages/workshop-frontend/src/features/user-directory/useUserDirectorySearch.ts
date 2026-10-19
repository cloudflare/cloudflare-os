import { useEffect, useState } from 'react'
import type { RpcPromise } from 'capnweb'
import type { UserDirectoryRecord } from '@gadgets/workshop-shared/api'

type Search = (query: string) => RpcPromise<UserDirectoryRecord[]>
type SearchSnapshot = {
  status: 'loading' | 'failed' | 'ready'
  query: string
  results: UserDirectoryRecord[]
  search?: Search
}

const EMPTY_SEARCH: SearchSnapshot = { status: 'ready', query: '', results: [] }

/** Debounced directory results are usable only for the current query and search scope. */
export function useUserDirectorySearch({
  query,
  enabled,
  search,
}: {
  query: string
  enabled: boolean
  search: Search
}) {
  const [snapshot, setSnapshot] = useState<SearchSnapshot>(EMPTY_SEARCH)
  const searching = enabled && query !== ''
  const current = searching
    ? snapshot.query === query && snapshot.search === search
    : query === '' && snapshot.query === ''
  // Effects run after rendering: never expose a previous query's results in that gap.
  const status = searching ? current ? snapshot.status : 'loading' : 'ready'
  const results = searching && current ? snapshot.results : EMPTY_SEARCH.results

  useEffect(() => {
    if (!searching) {
      setSnapshot(EMPTY_SEARCH)
      return
    }
    let cancelled = false
    let request: RpcPromise<UserDirectoryRecord[]> | undefined
    setSnapshot({ status: 'loading', query, results: [], search })
    // Every keystroke from every user would otherwise hit the one directory DO.
    const timer = window.setTimeout(() => {
      const pending = search(query)
      request = pending
      pending.finally(() => {
        if (request !== pending) return
        request = undefined
        pending[Symbol.dispose]()
      }).then(
        users => {
          if (!cancelled) setSnapshot({ status: 'ready', query, results: users, search })
        },
        error => {
          if (cancelled) return
          console.error('Failed to search user directory:', error)
          setSnapshot({ status: 'failed', query, results: [], search })
        },
      )
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      request?.[Symbol.dispose]()
      request = undefined
    }
  }, [query, search, searching])

  return {
    status,
    query: searching ? query : '',
    results,
    current,
    settled: current && status !== 'loading',
  }
}
