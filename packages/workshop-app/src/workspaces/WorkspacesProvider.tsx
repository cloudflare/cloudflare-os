import { useEffect, useState, type ReactNode } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { WorkspacesContext, type WorkspacesState } from './WorkspacesContext'

/**
 * Loads the user's workspaces when mounted, and again on `refresh()`. The list has no live updates
 * to subscribe to, so whoever changes it asks for a reload.
 */
export const WorkspacesProvider = ({ children }: { children: ReactNode }) => {
  const { api, reconnecting } = useApi()
  const [state, setState] = useState<WorkspacesState>({ status: 'loading' })
  // Bumped by refresh() to run the loading effect again.
  const [version, setVersion] = useState(0)
  // Stable, for whoever keeps it beyond a render, such as a chat session.
  const [refresh] = useState(() => () => setVersion((v) => v + 1))

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` loads it.
    if (reconnecting) return
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
  }, [api, reconnecting, version])

  return <WorkspacesContext value={{ state, refresh }}>{children}</WorkspacesContext>
}
