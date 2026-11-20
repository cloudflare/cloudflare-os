import { createContext, useContext } from 'react'
import type { NotificationMute, WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { WorkspaceRemoval } from '@/blocks/WorkspaceMoreMenu'
import type { LiveWorkspaceFields } from './LiveWorkspace'
import type { WorkspaceLooks } from './WorkspaceLooks'
import type { WorkspaceMemberships } from './WorkspaceMemberships'

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
  /** Renames a workspace, shown at once and undone if the server refuses. */
  rename: (id: string, title: string) => Promise<void>
  /**
   * Mutes a workspace's notifications until it is unmuted (`true`) or for a while (a
   * `NotificationMute`), or unmutes it, shown at once and undone if the server refuses.
   */
  setMuted: (id: string, muted: boolean | NotificationMute) => Promise<void>
  /**
   * Deletes a workspace or removes it from the list (see `removeWorkspace`), and drops it from the
   * list once the server has done it, as neither can be shown at once and undone.
   */
  remove: (id: string, removal: WorkspaceRemoval) => Promise<void>
  /** What a workspace said of itself since the list was read (see `useLiveWorkspace`), shown in the list. */
  update: (id: string, fields: LiveWorkspaceFields) => void
  /** Who has access to each workspace, as far as the workspaces have been asked. */
  memberships: WorkspaceMemberships
  /** How each workspace's icon is drawn, which is this device's to say. */
  looks: WorkspaceLooks
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

/** Renames a workspace (`setTitle`, to the server). Rejects with why, once it is undone. */
export const useRenameWorkspace = (): WorkspacesContextValue['rename'] => useWorkspacesContext().rename

/**
 * Mutes or unmutes a workspace's notifications (`setWorkspaceNotificationMute`, to the server):
 * its finished tasks then notify no tab or device. Rejects with why, once it is undone.
 */
export const useSetWorkspaceMuted = (): WorkspacesContextValue['setMuted'] => useWorkspacesContext().setMuted

/**
 * Deletes a workspace, as its owner (`deleteSelf`), or removes one shared with the user from their
 * list (`dismissSharedWorkspace`), dropping it from the list once done. Rejects with why.
 */
export const useRemoveWorkspace = (): WorkspacesContextValue['remove'] => useWorkspacesContext().remove

/** Shows what a workspace said of itself in the list (`useLiveWorkspace`). */
export const useUpdateWorkspace = (): WorkspacesContextValue['update'] => useWorkspacesContext().update

/** What is known of who has access to each workspace, kept from one page to the next (see `useWorkspaceMemberships`). */
export const useMembershipsStore = (): WorkspaceMemberships => useWorkspacesContext().memberships

/** How each workspace's icon is drawn on this device, the same wherever it is asked (see `useWorkspaceLooks`). */
export const useLooksStore = (): WorkspaceLooks => useWorkspacesContext().looks
