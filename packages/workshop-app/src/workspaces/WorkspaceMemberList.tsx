import { AccessMenu } from '@/blocks/AccessMenu'
import { ListGroup } from '@/blocks/ListGroup'
import { MemberListItem } from '@/blocks/MemberListItem'
import { RemovalDialog } from '@/blocks/RemovalDialog'
import { useApi } from '@/rpc/ApiContext'
import { canChange, shareStanding } from './sharingRules'
import type { SharingSession, SharingSnapshot } from './SharingSession'
import { useRemoval } from './useRemoval'
import { workspaceMembers, type WorkspaceMember } from './workspaceMembers'

const ROLE_LABELS: Record<WorkspaceMember['role'], string> = {
  owner: 'Owner',
  build: 'Member',
  use: 'Can use',
}

export type WorkspaceMemberListProps = {
  /** Who the workspace is shared with, as its page reads it (`useSharing`). */
  snapshot: SharingSnapshot
  session: SharingSession
}

/**
 * Everyone with access to a workspace, the owner first. Whoever may take someone's access away
 * does it from the menu on their row, having been told what that would do.
 */
export const WorkspaceMemberList = ({ snapshot, session }: WorkspaceMemberListProps) => {
  const { user } = useApi()
  const standing = snapshot.status === 'ready' ? shareStanding(snapshot.metadata, user) : undefined
  const collaborators = snapshot.status === 'ready' ? snapshot.collaborators : []
  const removal = useRemoval({ session, people: [user, ...(standing ? [standing.owner] : []), ...collaborators] })
  // Someone who can only use it is not told who else can.
  const onlyUses = snapshot.status === 'ready' && snapshot.metadata.role === 'use'

  return (
    <>
      {snapshot.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading members…</p>}
      {snapshot.status === 'failed' && <p className="px-4 text-center text-base text-kumo-subtle">Couldn’t load members: {snapshot.message}</p>}
      {standing && (
        // Faded in as it arrives, as the Library's lists are.
        <div className="appears flex flex-col gap-4">
          <ListGroup label="Members">
            {workspaceMembers(standing.owner, collaborators).map(({ profile, role }) => {
              const person = collaborators.find((collaborator) => collaborator.profile.id === profile.id)
              const removable = person !== undefined && profile.id !== user.id && canChange(person, standing, user.id)
              return (
                <MemberListItem
                  key={profile.id}
                  name={profile.name}
                  role={ROLE_LABELS[role]}
                  you={profile.id === user.id}
                  access={removable
                    ? <AccessMenu label={ROLE_LABELS[role]} of={profile.name} remove={{ label: 'Remove from workspace', onRemove: () => removal.ask({ id: profile.id, name: profile.name }) }} />
                    : undefined}
                />
              )
            })}
            {onlyUses && <MemberListItem name={user.name} role="Can use" you />}
          </ListGroup>
          {onlyUses && <p className="px-4 text-center text-base text-kumo-subtle">Only its members can see who else is here.</p>}
        </div>
      )}
      {removal.dialog && <RemovalDialog {...removal.dialog} />}
    </>
  )
}
