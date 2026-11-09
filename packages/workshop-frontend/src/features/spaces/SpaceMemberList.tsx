import type { RefCallback } from 'react'
import { Trash } from '@phosphor-icons/react'
import type { SpaceMemberInfo, SpaceMemberRole } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { PersonAvatar } from '../../components/PersonAvatar'
import { WorkshopIconButton } from '../../components/WorkshopControls'
import { BUSY_CONTROL_CLASS_NAME } from './BusyButton'
import { SpaceRoleSelect } from './SpaceRoleSelect'
import { SPACE_ROLE_LABELS } from './spaceRoles'

/** A change to one member that the server refused or that failed, shown on that member's row. */
export type MemberFailure = { profileId: string; message: string }

/** What an admin can do to the listed members. */
export type MemberManagement = {
  /**
   * The change in flight, if any, which holds every other back: the member and the control it
   * was started from, which stays enabled so that it keeps the focus, or `other` for a change
   * started elsewhere in the dialog.
   */
  pending: { profileId: string; control: 'role' | 'remove' } | 'other' | null
  selectContainer: HTMLElement | null
  onRoleChange: (member: SpaceMemberInfo, role: SpaceMemberRole) => void
  onRemove: (member: SpaceMemberInfo) => void
}

/**
 * The people added to a space itself, with their roles: a space inside another may have none,
 * and a line says so in the list's place. Read-only unless `manage` is given, which adds a role
 * select to every member and a remove button to everyone but the viewer, who leaves the space
 * from the dialog's own control instead. Until the viewer is known no row can be told from
 * theirs, so none has a remove button: on the viewer's own row it would be a leave that asks
 * nothing first.
 *
 * A browser takes the focus from a control that becomes disabled, so the control a change was
 * started from is not disabled while that change is in flight. Its member's row says that it is
 * busy instead, and the caller ignores what is done on the control meanwhile.
 */
export const SpaceMemberList = ({ ref, members, currentUserId, manage, failure }: {
  /**
   * The list itself, or the line that stands in for it when nobody is listed, which can be
   * given the focus of a control that has left the dialog. A callback, since the two are
   * elements of different kinds and a ref object is typed for one.
   */
  ref?: RefCallback<HTMLElement>
  members: SpaceMemberInfo[]
  /** The viewer's profile id, once known. */
  currentUserId: string | undefined
  manage?: MemberManagement
  failure: MemberFailure | null
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const pending = manage?.pending ?? null
  if (members.length === 0) {
    return (
      <p
        ref={ref}
        tabIndex={-1}
        className="rounded-xl border border-kumo-line px-3 py-2.5 text-[13px] leading-[18px] text-kumo-subtle"
      >
        Nobody has been added to this space itself.
      </p>
    )
  }
  return (
    <ul
      ref={ref}
      tabIndex={-1}
      aria-label="Members"
      className="overflow-hidden rounded-xl border border-kumo-line"
    >
      {members.map((member, index) => {
        const { profile, role } = member
        const isViewer = profile.id === currentUserId
        // The control of this member that the change in flight was started from, if either.
        const busyControl = pending !== null && pending !== 'other' && pending.profileId === profile.id
          ? pending.control
          : null
        const roleBusy = busyControl === 'role'
        const removeBusy = busyControl === 'remove'
        return (
          <li
            key={profile.id}
            aria-busy={busyControl !== null || undefined}
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
              {manage ? (
                // The select shows the role the member has until the server has answered, and
                // cannot itself be marked as busy, so it is dimmed from around it.
                <span className={`shrink-0 ${roleBusy ? 'opacity-50' : ''}`}>
                  <SpaceRoleSelect
                    label={`Role of ${profile.name}`}
                    value={role}
                    disabled={pending !== null && !roleBusy}
                    container={manage.selectContainer}
                    onValueChange={(next) => manage.onRoleChange(member, next)}
                  />
                </span>
              ) : (
                <span className="shrink-0 text-[12px] leading-4 text-kumo-subtle">
                  {SPACE_ROLE_LABELS[role]}
                </span>
              )}
              {manage && currentUserId !== undefined && !isViewer && (
                <WorkshopIconButton
                  danger
                  className={`!h-7 !w-7 ${BUSY_CONTROL_CLASS_NAME}`}
                  aria-label={`Remove ${profile.name}`}
                  aria-disabled={removeBusy || undefined}
                  disabled={pending !== null && !removeBusy}
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
