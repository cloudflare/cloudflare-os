import { type KeyboardEvent, useCallback, useRef, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import type { SpaceMemberInfo, SpaceMemberRole, UserDirectoryRecord } from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../AuthContext'
import { WorkshopButton } from '../../components/WorkshopControls'
import { isImeComposing } from '../../keyboardEvent'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { useServerConfig } from '../../ServerConfigContext'
import { UserSearchCombobox, type UserSearchState } from '../user-directory/UserSearchCombobox'
import type { SpaceMemberAddOutcome } from './addSpaceMember'
import { SpaceRoleSelect } from './SpaceRoleSelect'
import { SPACE_ROLE_LABELS } from './spaceRoles'

// The directory refuses a search that leaves out more than 1,000 people, the searcher counted
// among them whether or not they are named.
const MAX_EXCLUDED_IDS = 999

// What the field for the person to add holds: its text, and the person taken from it, who is a
// result of the user directory or the text itself as a username or email. Editing the text
// gives the person up.
type PersonField = { text: string; person: UserDirectoryRecord | null }
const EMPTY_FIELD: PersonField = { text: '', person: null }

const NO_SEARCH: UserSearchState = { status: 'ready', query: '', resultCount: 0 }

// 'Name (id)' where the two differ, so that two accounts with one display name are told apart.
const personLabel = ({ id, name }: UserDirectoryRecord) => (name === id ? name : `${name} (${id})`)

/**
 * The row an admin of a team space adds a member from: the person, the role they get and the
 * button, and under it what the latest add came to when it did not simply add them. That line
 * outlasts the viewer's admin role, which a refused add may be the loss of.
 *
 * The person is a result of the user directory or the text as typed. The directory is a
 * convenience that is filled lazily, answers with a few matches and can be down, so the text
 * can be used as a username or email whatever a search for it found, once that search has
 * settled. Taking a person and adding them are two steps: Enter in the field does the first,
 * and Enter again the second.
 */
export const SpaceMemberAdd = ({ canAdd, members, disabled, selectContainer, onAdd }: {
  /** The viewer is an admin of a team space: the field, the role and the button are offered. */
  canAdd: boolean
  /** The space's members, whom a search leaves out. */
  members: SpaceMemberInfo[]
  /** Another change to the space is in flight, so no add can be started. */
  disabled: boolean
  /** Where the role's options are rendered, so they sit above the dialog. */
  selectContainer: HTMLElement | null
  /**
   * Adds the user with this username or email in this role. Resolves to how it ended once the
   * space has been read again; rejects with what the server refused.
   */
  onAdd: (username: string, role: SpaceMemberRole) => Promise<SpaceMemberAddOutcome>
}) => {
  const { authenticatedApi, currentUser } = useAuthenticatedApi()
  const searchEnabled = useServerConfig()?.userSearchEnabled ?? false
  const [field, setField] = useState(EMPTY_FIELD)
  // `UserSearchCombobox` hands out no ref to its input, which is reached through this wrapper.
  const fieldRef = useRef<HTMLDivElement>(null)
  const [searchState, setSearchState] = useState(NO_SEARCH)
  const [role, setRole] = useState<SpaceMemberRole>('use')
  const [adding, setAdding] = useState(false)
  // What the latest add came to, when it did not simply add the person.
  const [line, setLine] = useState<string | null>(null)

  const viewerId = currentUser?.id
  // Memoized because the field starts its search again whenever this changes identity. The
  // directory leaves the searcher out itself, so the viewer's id is not spent on the limit.
  const searchPeople = useCallback(
    (query: string) => authenticatedApi.searchUsers(
      query,
      members.map(({ profile }) => profile.id).filter(id => id !== viewerId).slice(0, MAX_EXCLUDED_IDS),
    ),
    [authenticatedApi, members, viewerId],
  )

  const text = field.text.trim()
  // The search for exactly this text has settled: it found people, found nobody, or failed.
  const textUsable = searchEnabled && field.person === null && text !== '' &&
    searchState.query === text && searchState.status !== 'loading'

  const focusField = () => fieldRef.current?.querySelector('input')?.focus()

  const takeText = () => {
    setField({ text, person: { id: text, name: text } })
    setLine(null)
    // The button the text was taken from goes with that, and with it the focus it may have had.
    focusField()
  }

  const add = async () => {
    const { person } = field
    if (!person || adding || disabled) return
    // The button is disabled from here on, and stays so once the field is empty, so the field
    // takes the focus, ready for the next person. It stays live while the add is in flight.
    focusField()
    setAdding(true)
    setLine(null)
    // What has been typed into the field since the add began is left there.
    const emptyField = () => setField(current => (current.person === person ? EMPTY_FIELD : current))
    try {
      const outcome = await onAdd(person.id, role)
      switch (outcome.kind) {
        case 'added':
          emptyField()
          break
        case 'already-member': {
          const { profile } = outcome.member
          const was = `${profile.name} was already a member, as ${SPACE_ROLE_LABELS[outcome.was]}.`
          emptyField()
          setLine(outcome.was === role ? was : `${was} Their role is now ${SPACE_ROLE_LABELS[role]}.`)
          break
        }
        case 'held-back':
          setLine(`${personLabel(person)}: Already a member. Change their role in the list.`)
          break
        case 'no-account':
          setLine(`${personLabel(person)}: No account found for that username or email.`)
          break
      }
    } catch (err) {
      logRpcFailure('Failed to add a space member:', err)
      const reason = rpcFailureDescription(err) ?? 'Couldn’t add this person. Try again.'
      setLine(`${personLabel(person)}: ${reason}`)
    } finally {
      setAdding(false)
    }
  }

  // The field calls `preventDefault` on its Enter and lets it bubble, so this runs after the
  // field's own handling of the same press. It reads the person of the render the press was
  // made in: the press that takes a person finds none held here, and does not also add them.
  const handleFieldKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || isImeComposing(event) || !(event.target instanceof HTMLInputElement)) return
    if (field.person) void add()
    // With results on offer Enter is the field's, which takes the highlighted one.
    else if (textUsable && (searchState.status === 'failed' || searchState.resultCount === 0)) takeText()
  }

  if (!canAdd && line === null) return null
  return (
    <div className="mb-3">
      {canAdd && (
        <>
          <div
            className="themed-compact-shadow flex flex-wrap items-start gap-2 rounded-2xl border border-kumo-line/80 bg-kumo-base p-1.5 pl-3 transition-[border-color,box-shadow] focus-within:border-kumo-fill"
            data-keeper-ignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
          >
            <div
              ref={fieldRef}
              className="flex min-w-0 grow basis-full sm:basis-0"
              onKeyDown={handleFieldKeyDown}
            >
              <UserSearchCombobox
                authenticatedApi={authenticatedApi}
                value={field.text}
                selected={field.person !== null}
                searchEnabled={searchEnabled}
                inputName="space-member-search"
                search={searchPeople}
                excludeIds={members.map(({ profile }) => profile.id)}
                onValueChange={(value) => {
                  setField({ text: value, person: null })
                  setLine(null)
                }}
                onSelect={(person) => {
                  setField({ text: person.name, person })
                  setLine(null)
                }}
                onSubmit={takeText}
                onSearchStateChange={setSearchState}
              />
            </div>
            <SpaceRoleSelect
              label="Role for the new member"
              value={role}
              disabled={adding}
              container={selectContainer}
              onValueChange={setRole}
            />
            <WorkshopButton
              tone="primary"
              className="grow !rounded-xl sm:min-w-[68px] sm:grow-0"
              disabled={!field.person || adding || disabled}
              onClick={() => void add()}
            >
              {adding ? 'Adding…' : 'Add'}
            </WorkshopButton>
          </div>
          {textUsable && (
            <Button
              variant="ghost"
              size="sm"
              className="mt-1.5 max-w-full"
              // The field's results are laid out above this button and go when the field loses
              // the focus, which a pointer press here would take: the button would move up from
              // under the pointer before the press was over, and the click would never land.
              onMouseDown={(event) => event.preventDefault()}
              onClick={takeText}
            >
              <span className="truncate">Use “{text}” as a username or email</span>
            </Button>
          )}
        </>
      )}
      {line !== null && (
        <p role="alert" className="mt-1.5 break-words px-1 text-[12px] leading-4 text-kumo-danger">
          {line}
        </p>
      )}
    </div>
  )
}
