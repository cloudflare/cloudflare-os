import { useEffect, useState, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { WorkspacesContext, type WorkspacesState } from './WorkspacesContext'

/**
 * Loads the user's workspaces when mounted, and again on `refresh()`. The list has no live updates
 * to subscribe to, so whoever changes it asks for a reload.
 */
export const WorkspacesProvider = ({ children }: { children: ReactNode }) => {
  const { api } = useApi()
  const [state, setState] = useState<WorkspacesState>({ status: 'loading' })
  // Bumped by refresh() to run the loading effect again.
  const [version, setVersion] = useState(0)

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
  }, [api, version])

  return <WorkspacesContext value={{ state, refresh: () => setVersion((v) => v + 1) }}>{children}</WorkspacesContext>
}
