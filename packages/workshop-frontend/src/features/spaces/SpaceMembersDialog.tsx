import { useMemo, useRef, useState } from 'react'
import type { RpcStub } from 'capnweb'
import type { Space, SpaceMemberInfo, SpaceMemberRole } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import {
  PeopleComposer,
  usePeopleComposer,
  withPerson,
  type StagedPerson,
} from '../../components/PeopleComposer'
import { WorkshopButton } from '../../components/WorkshopControls'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { useDialogSelectPortalContainer } from '../../useDialogSelectPortalContainer'
import { SpaceDialogFrame } from './SpaceDialogFrame'
import { SpaceMemberList, type MemberFailure } from './SpaceMemberList'
import { SpaceRoleSelect } from './SpaceRoleSelect'
import { assignableRoles, SPACE_ROLE_LABELS, SPACE_ROLES_DESCRIPTION } from './spaceRoles'
import { useSpace } from './useSpace'

const NO_MEMBERS: SpaceMemberInfo[] = []
const NO_ACCOUNT = 'No account found for that username or email.'
const ALREADY_A_MEMBER = 'Already a member. Change their role in the list.'
const NAME_LIST = new Intl.ListFormat('en', { type: 'conjunction' })
// The people entered become members only on 'Add', and 'Added' and 'Removed' are what is said of
// a member then, so a person entered or taken back out is announced in other words.
const ENTRY_ANNOUNCEMENTS = {
  staged: (label: string) => `${label} is listed to add.`,
  unstaged: (label: string) => `${label} is no longer listed.`,
}

// Logs why a person could not be added, and words it for their chip.
const reasonNotAdded = (err: unknown) => {
  logRpcFailure('Failed to add a space member:', err)
  return rpcFailureDescription(err) ?? 'Couldn’t add this person. Try again.'
}

/**
 * A space's members and their roles, with what a role lets a member do in the workspaces the
 * space lists. Every member sees the list and can leave the space, except a personal space's
 * owner. An admin can also add people with a role, change a member's role and remove a member.
 * The server decides each of those when it is asked, so a refusal (the last admin, a personal
 * space's owner, a user with no account) is shown where the change was made.
 */
export const SpaceMembersDialog = ({ spaceKey, onClose, onLeft }: {
  spaceKey: string
  /**
   * The user's own role may have changed by the time this is called, and the space may have
   * stopped counting them as a member.
   */
  onClose: () => void
  /** The user left the space. Closing the dialog is the caller's. */
  onLeft: () => void
}) => {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const { state, refresh, change } = useSpace(spaceKey)
  const selectContainer = useDialogSelectPortalContainer()
  const [resultsContainer, setResultsContainer] = useState<HTMLDivElement | null>(null)
  const [staged, setStaged] = useState<StagedPerson[]>([])
  const [addRole, setAddRole] = useState<SpaceMemberRole>('use')
  const [adding, setAdding] = useState(false)
  // Guards the add against a second submit before `adding` has rendered.
  const addingRef = useRef(false)
  // A member's role change or removal is in flight.
  const [changing, setChanging] = useState(false)
  const [failure, setFailure] = useState<MemberFailure | null>(null)
  // Leaving takes a second step. `declined` is `idle` reached by cancelling that step, which
  // hands focus back to the button that started it.
  const [leaveStep, setLeaveStep] = useState<'idle' | 'confirming' | 'declined'>('idle')
  const [leaving, setLeaving] = useState(false)
  const [leaveFailure, setLeaveFailure] = useState<string | null>(null)
  // Announces a change that worked: the list it shows up in may be out of a screen reader's view.
  const [notice, setNotice] = useState('')
  const [retrying, setRetrying] = useState(false)

  const ready = state.status === 'ready' ? state : null
  const members = ready?.members ?? NO_MEMBERS
  // Memoized because the composer restarts its search whenever this array changes identity.
  const memberIds = useMemo(() => members.map(({ profile }) => profile.id), [members])
  const isAdmin = ready?.info.role === 'admin'
  const personalOwnerId = ready?.info.kind === 'personal' ? ready.info.owner?.id : undefined
  const canLeave = currentUser !== null && ready !== null && currentUser.id !== personalOwnerId
  const busy = adding || changing || leaving
  const composer = usePeopleComposer({
    api: authenticatedApi,
    people: staged,
    onPersonAdd: person => setStaged(current => withPerson(current, person)),
    onPersonRemove: person => setStaged(current => current.filter(entry => entry.id !== person.id)),
    excluded: ready ? { status: 'ready', ids: memberIds } : { status: 'loading' },
    pending: adding,
    onSubmit: () => void handleAdd(),
    announce: ENTRY_ANNOUNCEMENTS,
  })
  // The composer outlives the viewer's admin role while it holds chips: one that failed carries
  // the reason, which may be that very loss of the role.
  const composerShown = isAdmin || staged.length > 0

  // Adds everyone staged, plus whatever the field still holds. `setMemberRole` sets a role
  // exactly, so someone who is already a member is held back here: sending them would change
  // their role to the one picked for the newcomers. That check is against the members as read
  // for this add, not the list on show, which is as old as the viewer's last change: another
  // admin may have added someone since. The calls that follow are independent, so they are all
  // issued together (pipelined over the one connection) and the space is read once afterwards.
  // A person who could not be added keeps their chip, carrying the reason.
  const handleAdd = async (extra: StagedPerson | null = null) => {
    const people = extra ? withPerson(staged, extra) : staged
    if (people.length === 0 || addingRef.current || changing || leaving) return
    if (extra) composer.stage(extra)

    addingRef.current = true
    setAdding(true)
    setNotice('')
    try {
      // Each outcome is the member added, or the reason that person was not.
      const outcomes = await change(async space => {
        let current: Set<string>
        try {
          current = new Set((await space.listMembers()).map(({ profile }) => profile.id))
        } catch (err) {
          const reason = reasonNotAdded(err)
          return people.map(() => reason)
        }
        return Promise.all(people.map(async person => {
          if (current.has(person.id)) return ALREADY_A_MEMBER
          try {
            return (await space.setMemberRole(person.id, addRole)) ?? NO_ACCOUNT
          } catch (err) {
            return reasonNotAdded(err)
          }
        }))
      })
      const added: string[] = []
      const failed = new Map<string, StagedPerson>()
      outcomes.forEach((outcome, index) => {
        const person = people[index]
        if (typeof outcome === 'string') failed.set(person.id, { ...person, error: outcome })
        else added.push(outcome.profile.name)
      })
      // Only the chips this batch sent are touched; anyone staged since stays as they are.
      const batch = new Set(people.map(person => person.id))
      setStaged(current => current.flatMap(person =>
        batch.has(person.id) ? (failed.has(person.id) ? [failed.get(person.id)!] : []) : [person]))
      if (added.length > 0) {
        setNotice(`Added ${NAME_LIST.format(added)} with the role ${SPACE_ROLE_LABELS[addRole]}.`)
      }
    } finally {
      addingRef.current = false
      setAdding(false)
    }
  }

  // Runs one change to `member`. `action` resolves to null once the change is made, or to the
  // reason it was not; that reason, like a thrown refusal, is shown on the member's row.
  const changeMember = async (
    member: SpaceMemberInfo,
    action: (space: RpcStub<Space>) => Promise<string | null>,
    done: string,
    fallback: string,
  ) => {
    if (busy) return
    setChanging(true)
    setFailure(null)
    setNotice('')
    try {
      const refusal = await change(action)
      if (refusal === null) setNotice(done)
      else setFailure({ profileId: member.profile.id, message: refusal })
    } catch (err) {
      logRpcFailure('Failed to change a space member:', err)
      setFailure({
        profileId: member.profile.id,
        message: rpcFailureDescription(err) ?? fallback,
      })
    } finally {
      setChanging(false)
    }
  }

  const handleRoleChange = (member: SpaceMemberInfo, role: SpaceMemberRole) => {
    if (role === member.role) return
    void changeMember(
      member,
      async space => (await space.setMemberRole(member.profile.id, role)) ? null : NO_ACCOUNT,
      `${member.profile.name}’s role is now ${SPACE_ROLE_LABELS[role]}.`,
      'Couldn’t change the role. Try again.',
    )
  }

  const handleRemove = (member: SpaceMemberInfo) => void changeMember(
    member,
    async space => {
      await space.removeMember(member.profile.id)
      return null
    },
    `Removed ${member.profile.name}.`,
    'Couldn’t remove this member. Try again.',
  )

  const handleLeave = async () => {
    if (!currentUser || busy) return
    setLeaving(true)
    setLeaveFailure(null)
    try {
      await change(space => space.removeMember(currentUser.id))
      onLeft()
    } catch (err) {
      logRpcFailure('Failed to leave a space:', err)
      setLeaveFailure(rpcFailureDescription(err) ?? 'Couldn’t leave the space. Try again.')
    } finally {
      setLeaving(false)
    }
  }

  const handleRetry = async () => {
    setRetrying(true)
    try {
      await refresh()
    } finally {
      setRetrying(false)
    }
  }

  const title = !ready
    ? 'Members'
    : ready.info.kind === 'team'
      ? `Members of ${ready.info.name}`
      : personalOwnerId === currentUser?.id
        ? 'Members of your personal space'
        : `Members of ${ready.info.name}’s personal space`

  return (
    <SpaceDialogFrame
      layout="list"
      title={title}
      description={SPACE_ROLES_DESCRIPTION}
      busy={busy}
      onClose={onClose}
    >
      <div
        // The composer's result list is positioned over this body from outside it, so the body
        // must not scroll underneath while the list is showing.
        className={`chat-panel min-h-0 flex-1 overscroll-contain px-5 py-4 ${composerShown && composer.resultsOpen ? 'overflow-hidden' : 'overflow-y-auto'}`}
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
            <WorkshopButton loading={retrying} onClick={() => void handleRetry()}>Try again</WorkshopButton>
          </div>
        )}
        {ready && (
          <>
            {composerShown && (
              <div className="mb-3">
                <PeopleComposer composer={composer} resultsContainer={resultsContainer}>
                  <SpaceRoleSelect
                    label="Role for the people added"
                    value={addRole}
                    roles={assignableRoles(ready.info.kind)}
                    disabled={adding}
                    container={selectContainer}
                    onValueChange={setAddRole}
                  />
                  <WorkshopButton
                    tone="primary"
                    className="col-span-3 w-full !rounded-xl sm:col-span-1 sm:w-auto sm:min-w-[68px]"
                    onMouseDown={(event) => {
                      // Keeps the highlighted result until the click handler has taken it.
                      if (composer.resultsOpen) event.preventDefault()
                    }}
                    onClick={() => void handleAdd(composer.draft)}
                    disabled={!composer.canSubmit || busy}
                  >
                    {adding
                      ? 'Adding…'
                      : composer.recipients.length > 1 ? `Add ${composer.recipients.length} people` : 'Add'}
                  </WorkshopButton>
                </PeopleComposer>
                {/* A personal space lists every workspace its owner has not placed in a team
                    space, which may be more than the owner has in mind when adding someone. */}
                {ready.info.kind === 'personal' && (
                  <p className="mt-2 text-[12px] leading-4 text-kumo-subtle">
                    The people you add will be able to open every workspace this space lists.
                  </p>
                )}
              </div>
            )}
            <SpaceMemberList
              members={members}
              currentUserId={currentUser?.id}
              fixedAdminId={personalOwnerId}
              manage={isAdmin ? {
                roles: assignableRoles(ready.info.kind),
                pending: busy,
                selectContainer,
                onRoleChange: handleRoleChange,
                onRemove: handleRemove,
              } : undefined}
              failure={failure}
            />
            <p role="status" aria-live="polite" className="sr-only">{notice}</p>
          </>
        )}
      </div>
      {canLeave && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-kumo-line px-5 py-3">
          {leaveFailure && (
            <p role="alert" className="w-full text-[12px] leading-4 text-kumo-danger">{leaveFailure}</p>
          )}
          {leaveStep === 'confirming' ? (
            // The question takes the place of the button that asked for it, so a double click on
            // that button cannot also confirm.
            <>
              <p className="mr-auto text-[13px] leading-[18px] text-kumo-default">Leave this space?</p>
              <WorkshopButton autoFocus disabled={busy} onClick={() => setLeaveStep('declined')}>
                Cancel
              </WorkshopButton>
              <WorkshopButton tone="danger" disabled={busy} onClick={() => void handleLeave()}>
                {leaving ? 'Leaving…' : 'Leave'}
              </WorkshopButton>
            </>
          ) : (
            <WorkshopButton
              autoFocus={leaveStep === 'declined'}
              disabled={busy}
              onClick={() => setLeaveStep('confirming')}
            >
              Leave space
            </WorkshopButton>
          )}
        </div>
      )}
      <div ref={setResultsContainer} className="pointer-events-none absolute inset-0 z-30" />
    </SpaceDialogFrame>
  )
}
