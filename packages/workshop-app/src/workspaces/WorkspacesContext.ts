import { createContext, useContext } from 'react'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'

export type WorkspacesState =
  | { status: 'loading' }
  | { status: 'ready'; workspaces: WorkspaceMetadataWithTimestamps[] }
  | { status: 'failed'; message: string }

export type WorkspacesContextValue = {
  state: WorkspacesState
  /** Loads the list again, e.g. after a conversation was created. The current list stays up meanwhile. */
  refresh: () => void
}

export const WorkspacesContext = createContext<WorkspacesContextValue | null>(null)

const useWorkspacesContext = (): WorkspacesContextValue => {
  const value = useContext(WorkspacesContext)
  if (!value) throw new Error('Workspaces hooks must be used inside WorkspacesProvider')
  return value
}

/** The user's workspaces, most recently active first. Only available beneath `WorkspacesProvider`. */
export const useWorkspaces = (): WorkspacesState => useWorkspacesContext().state

/** Reloads the workspace list. */
export const useRefreshWorkspaces = (): (() => void) => useWorkspacesContext().refresh
