import { useEffect, useState } from 'react'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { readLibrary } from './readLibrary'

export type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; outputs: OutputSummary[] }
  | { status: 'failed'; message: string; retry: () => void }

/**
 * Everything the user's workspaces, and those shared with them, have made, most recently active
 * first. Loaded when mounted, and again whenever `key` changes, such as for each chat it is shown
 * beside, keeping what was loaded meanwhile; `null` wants nothing, and loads nothing. Workspaces
 * older than the index are swept into it a batch at a time, so it is asked again, a little later each
 * time, until it says it has caught up (`readLibrary`), showing what has arrived each time.
 */
export const useLibrary = (key?: string | null): LibraryState => {
  const { api, reconnecting } = useApi()
  const [state, setState] = useState<LibraryState>({ status: 'loading' })
  // Bumped to ask again after a failure.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` reads it.
    if (key === null || reconnecting) return
    const reading = new AbortController()
    readLibrary(
      () => api.listOutputs(),
      (outputs) => setState({ status: 'ready', outputs: outputs.toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime()) }),
      reading.signal,
    ).catch((error: unknown) => {
      if (reading.signal.aborted) return
      const retry = () => {
        setState({ status: 'loading' })
        setAttempt((current) => current + 1)
      }
      setState({ status: 'failed', message: error instanceof Error ? error.message : String(error), retry })
    })
    return () => reading.abort()
  }, [api, reconnecting, key, attempt])

  return state
}
