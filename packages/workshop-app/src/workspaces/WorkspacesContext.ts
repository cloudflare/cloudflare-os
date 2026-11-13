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
  /** Stars or unstars a workspace, shown at once and undone if the server refuses. */
  setPinned: (id: string, pinned: boolean) => Promise<void>
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

/** Stars or unstars a workspace (`pinned`, to the server). Rejects with why, once it is undone. */
export const useSetWorkspacePinned = (): WorkspacesContextValue['setPinned'] => useWorkspacesContext().setPinned
