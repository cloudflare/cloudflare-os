import { useEffect, useState } from 'react'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'

export type LibraryState =
  | { status: 'loading' }
  | { status: 'ready'; outputs: OutputSummary[] }
  | { status: 'failed'; message: string }

/**
 * Everything the user's workspaces, and those shared with them, have made, most recently active
 * first. Loaded when mounted. Workspaces older than the index are swept into it a batch at a time,
 * so it is asked again until it says it has caught up, showing what has arrived each time.
 */
export const useLibrary = (): LibraryState => {
  const { api } = useApi()
  const [state, setState] = useState<LibraryState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (;;) {
        const { outputs, catchingUp } = await api.listOutputs()
        if (cancelled) return
        setState({ status: 'ready', outputs: outputs.toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime()) })
        if (!catchingUp) return
      }
    })().catch((error: unknown) => {
      if (!cancelled) setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
    })
    return () => {
      cancelled = true
    }
  }, [api])

  return state
}
