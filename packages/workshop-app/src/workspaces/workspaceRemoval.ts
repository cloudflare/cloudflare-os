import type { AuthenticatedApi, Overseer, WorkspaceMetadata } from '@gadgets/workshop-shared/api'
import type { WorkspaceRemoval } from '@/blocks/WorkspaceMoreMenu'

/**
 * How the viewer takes `workspace` out of their list: deleting it, where it is their own (it names
 * no owner), and otherwise removing it from their list, which is all someone it was shared with
 * may do.
 */
export const removalOf = ({ owner }: Pick<WorkspaceMetadata, 'owner'>): WorkspaceRemoval => (owner === undefined ? 'delete' : 'dismiss')

/** What removing a workspace calls on: the API, and the workspace it opens to delete one. */
export type RemovalApi = Pick<AuthenticatedApi, 'dismissSharedWorkspace'> & {
  openWorkspace(workspaceId: string): Pick<Overseer, 'deleteSelf'> & Disposable
}

/**
 * Deletes the workspace `workspaceId`, with everything in it and for everyone (`deleteSelf`), or
 * removes it from the viewer's list (`dismissSharedWorkspace`), which leaves their access: opening
 * it again brings it back. Rejects with why it could not be.
 */
export const removeWorkspace = async (api: RemovalApi, workspaceId: string, removal: WorkspaceRemoval) => {
  if (removal === 'dismiss') return api.dismissSharedWorkspace(workspaceId)
  const overseer = api.openWorkspace(workspaceId)
  try {
    await overseer.deleteSelf()
  } finally {
    overseer[Symbol.dispose]()
  }
}
