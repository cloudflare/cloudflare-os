import { useEffect, useState, type ReactNode } from 'react'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
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

  const mark = (id: string, change: Partial<WorkspaceMetadataWithTimestamps>) =>
    setState((current) =>
      current.status === 'ready'
        ? { ...current, workspaces: current.workspaces.map((workspace) => (workspace.id === id ? { ...workspace, ...change } : workspace)) }
        : current,
    )
  const setPinned = async (id: string, pinned: boolean) => {
    mark(id, { pinned })
    try {
      await api.setWorkspacePinned(id, pinned)
    } catch (error) {
      mark(id, { pinned: !pinned })
      throw error
    }
  }
  const rename = async (id: string, title: string) => {
    const before = state.status === 'ready' ? state.workspaces.find((workspace) => workspace.id === id)?.title : undefined
    mark(id, { title })
    const overseer = api.openWorkspace(id)
    try {
      await overseer.setTitle(title)
    } catch (error) {
      if (before !== undefined) mark(id, { title: before })
      throw error
    } finally {
      overseer[Symbol.dispose]()
    }
  }

  return <WorkspacesContext value={{ state, refresh, setPinned, rename }}>{children}</WorkspacesContext>
}
