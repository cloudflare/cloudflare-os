import { useEffect, useSyncExternalStore } from 'react'
import type { WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { useApi } from '@/rpc/ApiContext'
import { useMembershipsStore } from './WorkspacesContext'
import { workspaceMembers, type WorkspaceMember } from './workspaceMembers'

/**
 * Who has access to each of `workspaces`, the owner first, by the workspace's id: those that have
 * said so far, the rest following as they are asked, in the order given (`WorkspaceMemberships`).
 */
export const useWorkspaceMemberships = (workspaces: WorkspaceMetadataWithTimestamps[]): ReadonlyMap<string, WorkspaceMember[]> => {
  const { api, user, reconnecting } = useApi()
  const store = useMembershipsStore()
  const memberships = useSyncExternalStore(store.subscribe, store.snapshot)
  // The list is a new one with every change to any workspace: only which are listed matters here.
  const ids = workspaces.map(({ id }) => id).join(' ')

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` takes it up.
    if (reconnecting || ids === '') return
    // The list says who owns a workspace only to those who do not.
    const owners = new Map(workspaces.map(({ id, owner }) => [id, owner ?? user]))
    store.want(ids.split(' '), async (id) => {
      const overseer = api.openWorkspace(id)
      try {
        return workspaceMembers(owners.get(id) ?? user, await overseer.listCollaborators())
      } finally {
        overseer[Symbol.dispose]()
      }
    })
    return () => store.stop()
    // `workspaces` is read for its owners, which do not change for the ids listed.
  }, [store, api, user, reconnecting, ids])

  return memberships
}
