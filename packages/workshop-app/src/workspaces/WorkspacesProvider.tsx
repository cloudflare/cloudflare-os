import { useEffect, useState, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { WorkspacesContext, type WorkspacesState } from './WorkspacesContext'

/** Loads the user's workspaces once, when mounted. The list has no live updates to subscribe to. */
export const WorkspacesProvider = ({ children }: { children: ReactNode }) => {
  const { api } = useApi()
  const [state, setState] = useState<WorkspacesState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    api.listWorkspaces().then(
      (workspaces) => {
        if (cancelled) return
        const byRecentActivity = workspaces.toSorted((a, b) => b.lastActive.getTime() - a.lastActive.getTime())
        setState({ status: 'ready', workspaces: byRecentActivity })
      },
      (error) => {
        if (!cancelled) setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  return <WorkspacesContext value={state}>{children}</WorkspacesContext>
}
