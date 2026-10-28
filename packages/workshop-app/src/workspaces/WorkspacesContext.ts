import { createContext, useContext } from 'react'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'

export type WorkspacesState =
  | { status: 'loading' }
  | { status: 'ready'; workspaces: WorkspaceMetadataWithTimestamps[] }
  | { status: 'failed'; message: string }

export const WorkspacesContext = createContext<WorkspacesState | null>(null)

/** The user's workspaces, most recently active first. Only available beneath `WorkspacesProvider`. */
export const useWorkspaces = (): WorkspacesState => {
  const state = useContext(WorkspacesContext)
  if (!state) throw new Error('useWorkspaces must be used inside WorkspacesProvider')
  return state
}
