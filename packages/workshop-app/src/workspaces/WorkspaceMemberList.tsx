import { ListGroup } from '@/blocks/ListGroup'
import { MemberListItem } from '@/blocks/MemberListItem'
import { useApi } from '@/rpc/ApiContext'
import { useWorkspaceMembers } from './useWorkspaceMembers'
import type { WorkspaceMember } from './workspaceMembers'

const ROLE_LABELS: Record<WorkspaceMember['role'], string> = {
  owner: 'Owner',
  build: 'Can edit',
  use: 'Can use',
}

/** Everyone with access to a workspace, the owner first. */
export const WorkspaceMemberList = ({ workspaceId }: { workspaceId: string }) => {
  const { user } = useApi()
  const members = useWorkspaceMembers(workspaceId)

  return (
    <>
      {members.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading members…</p>}
      {members.status === 'failed' && <p className="px-4 text-center text-base text-kumo-subtle">Couldn’t load members: {members.message}</p>}
      {members.status === 'ready' && (
        <ListGroup label="Members">
          {members.members.map(({ profile, role }) => (
            <MemberListItem key={profile.id} name={profile.name} role={ROLE_LABELS[role]} you={profile.id === user.id} />
          ))}
        </ListGroup>
      )}
    </>
  )
}
