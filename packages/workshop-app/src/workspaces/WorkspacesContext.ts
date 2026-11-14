import { createContext, useContext } from 'react'
import type { NotificationMute, UnreadThread, WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'

export type WorkspacesState =
  | { status: 'loading' }
  | { status: 'ready'; workspaces: WorkspaceMetadataWithTimestamps[] }
  | { status: 'failed'; message: string }

export type WorkspacesContextValue = {
  state: WorkspacesState
  /**
   * Every chat in the user's workspaces, as the account lists them (`getChatThreads()`), kept up
   * to date as they change. Undefined until listed, and while they cannot be.
   */
  chats: UnreadThread[] | undefined
  /** Loads the list again, e.g. after a conversation was created. The current list stays up meanwhile. */
  refresh: () => void
  /** Stars or unstars a workspace, shown at once and undone if the server refuses. */
  setPinned: (id: string, pinned: boolean) => Promise<void>
  /** Renames a workspace, shown at once and undone if the server refuses. */
  rename: (id: string, title: string) => Promise<void>
  /** Mutes or unmutes a workspace's notifications (`null` unmutes), shown at once and undone if the server refuses. */
  setNotificationMute: (id: string, mute: NotificationMute | null) => Promise<void>
  /** Deletes a workspace and all it holds, taking it off the list once it has gone. */
  remove: (id: string) => Promise<void>
  /** Makes a named workspace, listed at once, and resolves to its id. */
  create: (title: string) => Promise<string>
}

export const WorkspacesContext = createContext<WorkspacesContextValue | null>(null)

const useWorkspacesContext = (): WorkspacesContextValue => {
  const value = useContext(WorkspacesContext)
  if (!value) throw new Error('Workspaces hooks must be used inside WorkspacesProvider')
  return value
}

/** The user's workspaces, most recently active first. Only available beneath `WorkspacesProvider`. */
export const useWorkspaces = (): WorkspacesState => useWorkspacesContext().state

/** Every chat in the user's workspaces, live; undefined until they are listed. */
export const useChatThreads = (): UnreadThread[] | undefined => useWorkspacesContext().chats

/** Reloads the workspace list. */
export const useRefreshWorkspaces = (): (() => void) => useWorkspacesContext().refresh

/** Stars or unstars a workspace (`pinned`, to the server). Rejects with why, once it is undone. */
export const useSetWorkspacePinned = (): WorkspacesContextValue['setPinned'] => useWorkspacesContext().setPinned

/** Renames a workspace (`setTitle`, to the server). Rejects with why, once it is undone. */
export const useRenameWorkspace = (): WorkspacesContextValue['rename'] => useWorkspacesContext().rename

/** Mutes or unmutes a workspace's notifications. Rejects with why, once it is undone. */
export const useSetNotificationMute = (): WorkspacesContextValue['setNotificationMute'] => useWorkspacesContext().setNotificationMute

/** Deletes a workspace (`deleteSelf`, to the server). Rejects with why, leaving it listed. */
export const useDeleteWorkspace = (): WorkspacesContextValue['remove'] => useWorkspacesContext().remove

/** Makes a named workspace (`newWorkspace`, to the server). Rejects with why, making none. */
export const useCreateWorkspace = (): WorkspacesContextValue['create'] => useWorkspacesContext().create

/** Whether a workspace's notifications are muted now: for good, or until a time not yet reached. */
export const isMuted = (mute: NotificationMute | undefined, now = Date.now()) =>
  mute !== undefined && (mute.indefinite === true || mute.until.getTime() > now)
