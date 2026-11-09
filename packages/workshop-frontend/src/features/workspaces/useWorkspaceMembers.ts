import { useEffect, useState } from 'react'
import type { AiChatAuthorInfo, CollaboratorInfo } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { logRpcFailure } from '../../rpcErrors'

/** A workspace's people: its owner, then everyone it is shared with. */
export type WorkspaceMembers = { people: AiChatAuthorInfo[]; collaborators: CollaboratorInfo[] }

/**
 * The members of each listed workspace, asked of every workspace at once in one pipelined call
 * apiece. A workspace the user can't list collaborators of counts its owner alone.
 */
export function useWorkspaceMembers(
  workspaces: { id: string; owner?: AiChatAuthorInfo }[],
  self: AiChatAuthorInfo | null,
) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [members, setMembers] = useState<ReadonlyMap<string, WorkspaceMembers>>(new Map())
  const key = workspaces.map(w => w.id).join(',')
  useEffect(() => {
    if (!self || !key) return
    let cancelled = false
    Promise.all(workspaces.map(async (workspace): Promise<[string, WorkspaceMembers]> => {
      const owner = workspace.owner ?? self
      const overseer = authenticatedApi.openWorkspace(workspace.id)
      try {
        const collaborators = await overseer.listCollaborators()
        const others = collaborators.map(c => c.profile).filter(p => p.id !== owner.id)
        return [workspace.id, { people: [owner, ...others], collaborators }]
      } catch (err) {
        logRpcFailure('Failed to list workspace members:', err)
        return [workspace.id, { people: [owner], collaborators: [] }]
      } finally {
        overseer[Symbol.dispose]()
      }
    })).then(entries => { if (!cancelled) setMembers(new Map(entries)) })
    return () => { cancelled = true }
    // `workspaces` is read through `key`, so a re-render with the same list doesn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticatedApi, key, self?.id])
  return members
}
