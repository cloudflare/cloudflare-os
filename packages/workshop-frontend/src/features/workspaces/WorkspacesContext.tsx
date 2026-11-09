import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { logRpcFailure } from '../../rpcErrors'

type WorkspacesContextValue = {
  /** Every workspace the user has, named or not, in no particular order. */
  workspaces: WorkspaceMetadataWithTimestamps[]
  /** True until the first listing arrives. */
  loading: boolean
  /** Look a workspace up by ID, if it is in the listing. */
  byId: (id: string) => WorkspaceMetadataWithTimestamps | undefined
  /** Fetch the listing again, e.g. after creating, renaming or pinning a workspace. */
  refresh: () => void
}

const WorkspacesContext = createContext<WorkspacesContextValue | null>(null)

/**
 * The user's workspace listing, shared by the sidebar, the composer's workspace picker and the
 * Workspaces page. `listWorkspaces()` has no live subscription, so consumers call `refresh()` after
 * a change they make, and the recent-chats list refreshes it when a chat appears in a workspace it
 * hasn't seen.
 */
export const WorkspacesProvider = ({ children }: { children: ReactNode }) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const [workspaces, setWorkspaces] = useState<WorkspaceMetadataWithTimestamps[]>([])
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.listWorkspaces()
      .then(list => {
        if (cancelled) return
        setWorkspaces(list)
        setLoading(false)
      })
      .catch(err => {
        logRpcFailure('Failed to list workspaces:', err)
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [authenticatedApi, version])

  const refresh = useCallback(() => setVersion(v => v + 1), [])
  const byId = useCallback((id: string) => workspaces.find(w => w.id === id), [workspaces])

  return (
    <WorkspacesContext.Provider value={{ workspaces, loading, byId, refresh }}>
      {children}
    </WorkspacesContext.Provider>
  )
}

/** The user's workspace listing. Must be rendered inside `WorkspacesProvider`. */
export const useWorkspaces = (): WorkspacesContextValue => {
  const value = useContext(WorkspacesContext)
  if (!value) throw new Error('useWorkspaces must be used inside WorkspacesProvider')
  return value
}

/** Named workspaces (see `WorkspaceMetadata.kind`), the ones listed as workspaces in the UI. */
export const isNamedWorkspace = (workspace: { kind?: string } | undefined): boolean =>
  workspace?.kind === 'workspace'

/**
 * A named workspace the user works in: their own, or one they were invited to. Someone given only
 * an app from it (the "use" role) has that app in their Library, not the workspace in their list.
 */
export const isMemberWorkspace = (workspace: { kind?: string; role?: string } | undefined): boolean =>
  isNamedWorkspace(workspace) && workspace?.role !== 'use'
