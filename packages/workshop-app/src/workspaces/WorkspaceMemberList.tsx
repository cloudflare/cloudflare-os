import { AccessMenu, Button, ListGroup, ListToolbar, MemberListItem, useListView } from '@gadgets/ui'
import { RemovalDialog } from '@/blocks/RemovalDialog'
import { useApi } from '@/rpc/ApiContext'
import { memberList } from './memberList'
import { UserAdd01Icon } from '@/components/icons'
import { canChange, shareStanding } from './sharingRules'
import type { SharingSession, SharingSnapshot } from './SharingSession'
import { useRemoval } from './useRemoval'
import { membersOnly, workspaceMembers, type WorkspaceMember } from './workspaceMembers'

const ROLE_LABELS: Record<WorkspaceMember['role'], string> = {
  owner: 'Owner',
  build: 'Member',
  // Not listed (`membersOnly`); for the record's sake.
  use: 'Can use',
}

export type WorkspaceMemberListProps = {
  /** Who the workspace is shared with, as its page reads it (`useSharing`). */
  snapshot: SharingSnapshot
  session: SharingSession
  /** Opens the invitation, from the controls over the list. Left out where the viewer may not invite. */
  onInvite?: () => void
}

/**
 * Everyone with access to a workspace, the owner first until another order is chosen, under a
 * search, the order, and the way to invite more. Whoever may take someone's access away does it
 * from the menu on their row, having been told what that would do.
 */
export const WorkspaceMemberList = ({ snapshot, session, onInvite }: WorkspaceMemberListProps) => {
  const { user } = useApi()
  const standing = snapshot.status === 'ready' ? shareStanding(snapshot.metadata, user) : undefined
  const collaborators = snapshot.status === 'ready' ? snapshot.collaborators : []
  const removal = useRemoval({ session, people: [user, ...(standing ? [standing.owner] : []), ...collaborators] })
  // Someone who can only use it is not told who else can.
  const onlyUses = snapshot.status === 'ready' && snapshot.metadata.role === 'use'
  // Who is in it: whoever only uses one of its apps is that app's, listed where it is shared from.
  const members = standing ? membersOnly(workspaceMembers(standing.owner, collaborators)) : []
  const list = useListView('workspace-members', memberList)
  const shown = list.narrow(members)

  return (
    <div className="flex flex-col gap-4">
      {(standing || onInvite) && (
        <ListToolbar
          noun="members"
          {...(standing ? { search: list.controls.search, order: list.controls.order } : {})}
          action={onInvite && <Button variant="primary" icon={UserAdd01Icon} onClick={onInvite}>Invite</Button>}
        />
      )}
      {snapshot.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading members…</p>}
      {snapshot.status === 'failed' && <p className="px-4 text-center text-base text-kumo-subtle">Couldn’t load members: {snapshot.message}</p>}
      {standing && (
        <div className="flex flex-col gap-4">
          {members.length > 0 && shown.length === 0 && (
            <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
              No members match.
              <Button variant="ghost" onClick={list.showAll}>Show all</Button>
            </p>
          )}
          {list.arrange(shown).map(({ key, label, entries }) => (
            <ListGroup key={key} label={label}>
              {entries.map(({ value: { profile, role } }) => {
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
          ))}
          {onlyUses && <p className="px-4 text-center text-base text-kumo-subtle">Only its members can see who else is here.</p>}
        </div>
      )}
      {removal.dialog && <RemovalDialog {...removal.dialog} />}
    </div>
  )
}
