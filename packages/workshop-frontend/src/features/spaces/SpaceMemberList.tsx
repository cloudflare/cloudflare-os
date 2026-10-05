import { Trash } from '@phosphor-icons/react'
import type { SpaceMemberInfo, SpaceMemberRole } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { PersonAvatar } from '../../components/PersonAvatar'
import { WorkshopIconButton } from '../../components/WorkshopControls'
import { SpaceRoleSelect } from './SpaceRoleSelect'
import { SPACE_ROLE_LABELS } from './spaceRoles'

/** A change to one member that the server refused or that failed, shown on that member's row. */
export type MemberFailure = { profileId: string; message: string }

/** What an admin can do to the listed members. */
export type MemberManagement = {
  /** The roles a member can be given in this space. */
  roles: readonly SpaceMemberRole[]
  /** A change is in flight, so no other can be started. */
  pending: boolean
  selectContainer: HTMLElement | null
  onRoleChange: (member: SpaceMemberInfo, role: SpaceMemberRole) => void
  onRemove: (member: SpaceMemberInfo) => void
}

/**
 * A space's members with their roles. Read-only unless `manage` is given, which adds a role
 * select to every member and a remove button to everyone but the viewer, who leaves the space
 * from the dialog's own control instead. Until the viewer is known no row can be told from
 * theirs, so none has a remove button: on the viewer's own row it would be a leave that asks
 * nothing first.
 */
export const SpaceMemberList = ({ members, currentUserId, fixedAdminId, manage, failure }: {
  members: SpaceMemberInfo[]
  /** The viewer's profile id, once known. */
  currentUserId: string | undefined
  /** A personal space's owner: always its admin, so their row offers no change. */
  fixedAdminId: string | undefined
  manage?: MemberManagement
  failure: MemberFailure | null
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  return (
    <ul aria-label="Members" className="overflow-hidden rounded-xl border border-kumo-line">
      {members.map((member, index) => {
        const { profile, role } = member
        const isViewer = profile.id === currentUserId
        const editable = manage !== undefined && profile.id !== fixedAdminId
        return (
          <li
            key={profile.id}
            className={`px-3 py-2.5 ${index > 0 ? 'border-t border-kumo-line' : ''}`}
          >
            <div className="flex items-center gap-3">
              <PersonAvatar api={authenticatedApi} userId={profile.id} name={profile.name} size={28} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] leading-[18px] text-kumo-default">
                  {profile.name}
                  {isViewer && <span className="text-kumo-subtle"> (you)</span>}
                </p>
                {profile.name !== profile.id && (
                  <p className="truncate font-mono text-[11px] leading-4 text-kumo-subtle">{profile.id}</p>
                )}
              </div>
              {editable ? (
                <SpaceRoleSelect
                  label={`Role of ${profile.name}`}
                  value={role}
                  roles={manage.roles}
                  disabled={manage.pending}
                  container={manage.selectContainer}
                  onValueChange={(next) => manage.onRoleChange(member, next)}
                />
              ) : (
                <span className="shrink-0 text-[12px] leading-4 text-kumo-subtle">
                  {SPACE_ROLE_LABELS[role]}
                </span>
              )}
              {editable && currentUserId !== undefined && !isViewer && (
                <WorkshopIconButton
                  danger
                  className="!h-7 !w-7"
                  aria-label={`Remove ${profile.name}`}
                  disabled={manage.pending}
                  onClick={() => manage.onRemove(member)}
                >
                  <Trash size={13} />
                </WorkshopIconButton>
              )}
            </div>
            {failure?.profileId === profile.id && (
              <p role="alert" className="mt-1.5 text-[12px] leading-4 text-kumo-danger">
                {failure.message}
              </p>
            )}
          </li>
        )
      })}
    </ul>
  )
}
