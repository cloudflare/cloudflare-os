import { AccessMenu } from '@/blocks/AccessMenu'
import { ListGroup } from '@/blocks/ListGroup'
import { MemberListItem } from '@/blocks/MemberListItem'
import { RemovalDialog } from '@/blocks/RemovalDialog'
import { useApi } from '@/rpc/ApiContext'
import type { SharingSession, SharingSnapshot } from '@/sharing/SharingSession'
import { canChange, shareStanding } from '@/sharing/sharingRules'
import { useRemoval } from '@/sharing/useRemoval'
import { workspaceMembers, type WorkspaceMember } from './workspaceMembers'

const ROLE_LABELS: Record<WorkspaceMember['role'], string> = {
  owner: 'Owner',
  build: 'Can edit',
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
  const removal = useRemoval({ session, people: [user, ...(standing ? [standing.owner] : []), ...collaborators], from: 'workspace' })

  return (
    <>
      {snapshot.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading members…</p>}
      {snapshot.status === 'failed' && <p className="px-4 text-center text-base text-kumo-subtle">Couldn’t load members: {snapshot.message}</p>}
      {standing && (
        // Faded in as it arrives, as the Library's lists are.
        <div className="appears flex flex-col">
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
                    access={removable ? (
                      <AccessMenu
                        label={ROLE_LABELS[role]}
                        of={profile.name}
                        remove={{
                          label: role === 'build' ? 'Remove from workspace' : 'Remove access',
                          onRemove: () => removal.ask({ id: profile.id, name: profile.name }),
                        }}
                      />
                    ) : undefined}
                  />
                )
              })}
            </ListGroup>
        </div>
      )}
      {removal.dialog && <RemovalDialog {...removal.dialog} />}
    </>
  )
}
