import { createContext, useContext } from 'react'
import type { WorkspaceRemoval } from '@/blocks/WorkspaceMoreMenu'
import type { LiveWorkspaceFields } from './LiveWorkspace'
import type { WorkspacesState } from './WorkspacesFeed'

export type WorkspacesContextValue = {
  state: WorkspacesState
  /** Stars or unstars a workspace, shown at once and undone if the server refuses. */
  setPinned: (id: string, pinned: boolean) => Promise<void>
  /** Renames a workspace, shown at once and undone if the server refuses. */
  rename: (id: string, title: string) => Promise<void>
  /**
   * Mutes a workspace's notifications until it is unmuted, or unmutes it, shown at once and
   * undone if the server refuses.
   */
  setMuted: (id: string, muted: boolean) => Promise<void>
  /**
   * Deletes a workspace or removes it from the list (see `removeWorkspace`), which the list shows
   * once the account says it has gone, as neither can be shown at once and undone.
   */
  remove: (id: string, removal: WorkspaceRemoval) => Promise<void>
  /** What the open workspace says of itself that the list does not keep (see `useLiveWorkspace`), shown in the list. */
  update: (id: string, fields: LiveWorkspaceFields) => void
}

export const WorkspacesContext = createContext<WorkspacesContextValue | null>(null)

const useWorkspacesContext = (): WorkspacesContextValue => {
  const value = useContext(WorkspacesContext)
  if (!value) throw new Error('Workspaces hooks must be used inside WorkspacesProvider')
  return value
}

/** The user's workspaces, live, most recently active first. Only available beneath `WorkspacesProvider`. */
export const useWorkspaces = (): WorkspacesState => useWorkspacesContext().state

/** Stars or unstars a workspace (`pinned`, to the server). Rejects with why, once it is undone. */
export const useSetWorkspacePinned = (): WorkspacesContextValue['setPinned'] => useWorkspacesContext().setPinned

/** Renames a workspace (`setTitle`, to the server). Rejects with why, once it is undone. */
export const useRenameWorkspace = (): WorkspacesContextValue['rename'] => useWorkspacesContext().rename

/**
 * Mutes or unmutes a workspace's notifications (`setWorkspaceNotificationMute`, to the server):
 * its finished tasks then notify no tab or device. Rejects with why, once it is undone.
 */
export const useSetWorkspaceMuted = (): WorkspacesContextValue['setMuted'] => useWorkspacesContext().setMuted

/**
 * Deletes a workspace, as its owner (`deleteSelf`), or removes one shared with the user from their
 * list (`dismissSharedWorkspace`). Rejects with why.
 */
export const useRemoveWorkspace = (): WorkspacesContextValue['remove'] => useWorkspacesContext().remove

/** Shows what the open workspace said of itself in the list (`useLiveWorkspace`). */
export const useUpdateWorkspace = (): WorkspacesContextValue['update'] => useWorkspacesContext().update
