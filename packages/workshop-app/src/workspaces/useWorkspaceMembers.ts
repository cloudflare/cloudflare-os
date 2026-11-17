import { useEffect, useState } from 'react'
import { useApi } from '@/rpc/ApiContext'
import { workspaceMembers, type WorkspaceMember } from './workspaceMembers'

export type WorkspaceMembersState =
  | { status: 'loading' }
  | { status: 'ready'; members: WorkspaceMember[] }
  | { status: 'failed'; message: string }

/**
 * Everyone with access to one workspace, the owner first, loaded once when mounted. The state is
 * not reset when `workspaceId` changes, so give the calling component a `key` of the id.
 */
export const useWorkspaceMembers = (workspaceId: string): WorkspaceMembersState => {
  const { api, user, reconnecting } = useApi()
  const [state, setState] = useState<WorkspaceMembersState>({ status: 'loading' })

  useEffect(() => {
    // Over a lost connection it could only fail; the new connection's `api` loads it.
    if (reconnecting) return
    let cancelled = false
    const overseer = api.openWorkspace(workspaceId)
    Promise.all([overseer.getMetadata(), overseer.listCollaborators()]).then(
      ([metadata, collaborators]) => {
        if (!cancelled) setState({ status: 'ready', members: workspaceMembers(metadata.owner ?? user, collaborators) })
      },
      (error) => {
        if (!cancelled) setState({ status: 'failed', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => {
      cancelled = true
      overseer[Symbol.dispose]()
    }
  }, [api, user, reconnecting, workspaceId])

  return state
}
