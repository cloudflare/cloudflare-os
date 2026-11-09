import { useEffect, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Space, SpaceMemberInfo, SpaceMemberRole } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { useDialogSelectPortalContainer } from '../../useDialogSelectPortalContainer'
import { addSpaceMember } from './addSpaceMember'
import { BusyButton } from './BusyButton'
import { changeSpaceMemberRole } from './changeSpaceMemberRole'
import { takeLostFocus, useFocusAfterAction } from './lostFocus'
import { SpaceDialogFrame } from './SpaceDialogFrame'
import { SpaceLeave } from './SpaceLeave'
import { SpaceMemberAdd } from './SpaceMemberAdd'
import { SpaceMemberList, type MemberFailure } from './SpaceMemberList'
import { SPACE_ROLE_LABELS, SPACE_ROLES_DESCRIPTION } from './spaceRoles'
import { useSpace } from './useSpace'

// The one change in flight, which holds every other back.
type Pending =
  | { kind: 'add' }
  | { kind: 'member'; profileId: string; control: 'role' | 'remove' }
  | { kind: 'leave' }

// What a member of the space itself who also holds a role above it is told once they have left.
const LEFT_BUT_STILL_A_MEMBER =
  'You are no longer one of this space’s own members. You still have access through a space above it.'

/**
 * A team space's members and their roles, with what a role lets a member do in the workspaces
 * the space lists. The list is the people added to the space itself. For a space inside
 * another, a note says that the members of the spaces above it also have access, to a viewer
 * who holds a role there: the space tells nobody else that it is inside one.
 *
 * Everyone the space counts as a member sees the list. An admin, whether or not they are in
 * it, can also add a person with a role, change a member's role and remove a member. Only
 * someone in the list can leave, and one who also holds a role above stays a member: the dialog
 * stays open and says so. The server decides each change when it is asked, so a refusal (the
 * last admin, a user with no account) is shown where the change was made. A personal space has
 * no members besides its owner: no screen opens this dialog for one, and one that is handed to
 * it gets the list and nothing to change it with.
 *
 * One change is made at a time, and the dialog stays open until it has settled. The control it
 * was started from stays enabled meanwhile, so that it keeps the focus; when the change takes
 * that control away, the member list takes the focus it had.
 */
export const SpaceMembersDialog = ({ spaceId, onClose, onLeft }: {
  /** The id of a space the viewer holds a role in. */
  spaceId: string
  /**
   * The user's own role may have changed by the time this is called, and the space may have
   * stopped counting them as a member.
   */
  onClose: () => void
  /**
   * The user left the space, which no longer counts them as a member. Closing the dialog is the
   * caller's. Never called after unmount.
   */
  onLeft: () => void
}) => {
  const { currentUser } = useAuthenticatedApi()
  const { state, refresh, change } = useSpace(spaceId)
  const selectContainer = useDialogSelectPortalContainer()
  const [pending, setPending] = useState<Pending | null>(null)
  const [failure, setFailure] = useState<MemberFailure | null>(null)
  // Announces a change that worked: the list it shows up in may be out of a screen reader's view.
  const [notice, setNotice] = useState('')
  const [retrying, setRetrying] = useState(false)
  // The viewer left the space from this dialog and is a member of it still, by a role above.
  const [leftHere, setLeftHere] = useState(false)
  const listRef = useRef<HTMLElement>(null)
  // Gives the member list the focus of a control that has left the dialog. An open dialog takes
  // the focus the browser drops, at once and once more on the next frame, so focus on the
  // dialog itself is focus nothing in it has, and the list is given it again after that frame.
  const focusListIfLost = () => {
    const list = listRef.current
    if (list && document.activeElement === list.closest('[role="dialog"]')) list.focus()
    else takeLostFocus(list)
  }
  const changeSettled = useFocusAfterAction(() => {
    focusListIfLost()
    requestAnimationFrame(focusListIfLost)
  })

  // Whether the dialog is mounted, for what answers after it has gone. The effect sets the ref
  // as well as clearing it, because a development build runs every effect's cleanup once right
  // after the mount and then the effect again.
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const ready = state.status === 'ready' ? state : null
  const isTeam = ready?.info.kind === 'team'
  // The role the space reports, which a role held above it may raise: an admin by inheritance
  // manages whether or not the list has them.
  const canManage = isTeam && ready.info.role === 'admin'
  // The space names its parent only to a viewer who holds a role there, which is also how the
  // viewer is known to be a member whatever the list says.
  const inherits = ready?.info.parent !== undefined
  const isDirect = ready !== null && currentUser !== null
    && ready.members.some(({ profile }) => profile.id === currentUser.id)

  // Runs one change to the space, which is read again whatever the change came to.
  const runChange = async <T,>(next: Pending, action: (space: RpcStub<Space>) => Promise<T>) => {
    setPending(next)
    setFailure(null)
    setNotice('')
    try {
      return await change(action)
    } finally {
      if (alive.current) {
        setPending(null)
        changeSettled()
      }
    }
  }

  const handleAdd = async (username: string, role: SpaceMemberRole) => {
    const outcome = await runChange({ kind: 'add' }, space => addSpaceMember(space, username, role))
    if (alive.current && outcome.kind === 'added') {
      setNotice(`Added ${outcome.member.profile.name} with the role ${SPACE_ROLE_LABELS[role]}.`)
    }
    return outcome
  }

  // Runs one change to `member`. `action` resolves to null once the change is made as asked, or
  // to what happened instead; that, like a thrown refusal, is shown on the member's row, or
  // above the list when the member has left it.
  const changeMember = async (
    member: SpaceMemberInfo,
    control: 'role' | 'remove',
    action: (space: RpcStub<Space>) => Promise<string | null>,
    done: string,
    fallback: string,
  ) => {
    if (pending) return
    const profileId = member.profile.id
    let refusal: string | null
    try {
      refusal = await runChange({ kind: 'member', profileId, control }, action)
    } catch (err) {
      logRpcFailure('Failed to change a space member:', err)
      refusal = rpcFailureDescription(err) ?? fallback
    }
    if (!alive.current) return
    if (refusal === null) setNotice(done)
    else setFailure({ profileId, message: refusal })
  }

  const handleRoleChange = (member: SpaceMemberInfo, role: SpaceMemberRole) => {
    if (role === member.role) return
    const { id, name } = member.profile
    void changeMember(
      member,
      'role',
      async space => {
        const outcome = await changeSpaceMemberRole(space, id, role)
        switch (outcome.kind) {
          case 'changed':
            return null
          case 'held-back':
            return `${name} is no longer a member of this space. Their role was not changed.`
          case 'added-back':
            return `${name} was no longer a member of this space. They are one again, as ${SPACE_ROLE_LABELS[role]}.`
          case 'no-account':
            return 'No account found for that username or email.'
        }
      },
      `${name}’s role is now ${SPACE_ROLE_LABELS[role]}.`,
      'Couldn’t change the role. Try again.',
    )
  }

  const handleRemove = (member: SpaceMemberInfo) => void changeMember(
    member,
    'remove',
    async space => {
      await space.removeMember(member.profile.id)
      return null
    },
    `Removed ${member.profile.name}.`,
    'Couldn’t remove this member. Try again.',
  )

  const leave = async (profileId: string) => {
    // As the space said before the leave: what it says afterwards is read by then.
    const staysMember = inherits
    await runChange({ kind: 'leave' }, space => space.removeMember(profileId))
    // A leave answered after the dialog has gone is not the caller's to act on: it would toast
    // and navigate from a page the user has left.
    if (!alive.current) return
    // A viewer who holds a role above the space has left its list and nothing else, so there
    // is nothing for the caller to take away: the dialog stays, and says what happened.
    if (staysMember) {
      setLeftHere(true)
      setNotice(LEFT_BUT_STILL_A_MEMBER)
    } else {
      onLeft()
    }
  }

  const handleRetry = async () => {
    setRetrying(true)
    try {
      await refresh()
    } finally {
      if (alive.current) {
        setRetrying(false)
        changeSettled()
      }
    }
  }

  return (
    <SpaceDialogFrame
      layout="list"
      title={ready ? `Members of ${ready.info.name}` : 'Members'}
      description={SPACE_ROLES_DESCRIPTION}
      busy={pending !== null}
      onClose={onClose}
      // Only someone in the list has a place in it to leave. Until the viewer is known, the
      // member who would leave is not.
      footer={isTeam && currentUser && isDirect ? (
        <SpaceLeave
          disabled={pending !== null && pending.kind !== 'leave'}
          onLeave={() => leave(currentUser.id)}
        />
      ) : undefined}
    >
      {state.status === 'loading' && (
        <p role="status" className="text-[13px] leading-[18px] text-kumo-subtle">Loading members…</p>
      )}
      {state.status === 'refused' && (
        <p role="alert" className="text-[13px] leading-[18px] text-kumo-default">
          You are no longer a member of this space.
        </p>
      )}
      {state.status === 'failed' && (
        <div role="alert" className="flex items-center justify-between gap-3">
          <p className="text-[13px] leading-[18px] text-kumo-danger">Couldn’t load this space.</p>
          <BusyButton busy={retrying} onClick={() => void handleRetry()}>Try again</BusyButton>
        </div>
      )}
      {ready && (
        <>
          {/* On screen as well as announced: the status line is not shown, and the viewer's row
              and `Leave space` have just gone. */}
          {leftHere && inherits && !isDirect && (
            <p className="mb-3 text-[13px] leading-[18px] text-kumo-default">{LEFT_BUT_STILL_A_MEMBER}</p>
          )}
          {inherits && (
            <p role="note" className="mb-3 text-[12px] leading-4 text-kumo-subtle">
              Members of the spaces above this one also have access, with the roles they hold there
              or higher. Only the people added to this space itself are listed. Your role here:
              {' '}{SPACE_ROLE_LABELS[ready.info.role]}.
            </p>
          )}
          <SpaceMemberAdd
            canAdd={canManage}
            members={ready.members}
            disabled={pending !== null && pending.kind !== 'add'}
            selectContainer={selectContainer}
            onAdd={handleAdd}
          />
          {/* A change that failed for someone who has left the list has no row to be shown on. */}
          {failure && !ready.members.some(({ profile }) => profile.id === failure.profileId) && (
            <p role="alert" className="mb-2 break-words px-1 text-[12px] leading-4 text-kumo-danger">
              {failure.message}
            </p>
          )}
          <SpaceMemberList
            ref={(list) => { listRef.current = list }}
            members={ready.members}
            currentUserId={currentUser?.id}
            manage={canManage ? {
              pending: pending === null ? null : pending.kind === 'member' ? pending : 'other',
              selectContainer,
              onRoleChange: handleRoleChange,
              onRemove: handleRemove,
            } : undefined}
            failure={failure}
          />
          <p role="status" aria-live="polite" className="sr-only">{notice}</p>
        </>
      )}
    </SpaceDialogFrame>
  )
}
