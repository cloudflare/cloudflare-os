import { useCallback, useId, useState, type MouseEvent, type Ref } from 'react'
import { Autocomplete, InputGroup } from '@cloudflare/kumo'
import { CheckCircleIcon, CheckIcon, InfoIcon, LinkIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { Autocomplete as AutocompletePrimitive } from '@cloudflare/kumo/primitives/autocomplete'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, UserDirectoryRecord } from '@gadgets/workshop-shared/api'
import { PersonAvatar } from '../../components/PersonAvatar'
import { roundButtonClass } from '../../components/RoundButton'
import { isImeComposing } from '../../keyboardEvent'
import { useUserDirectorySearch } from '../user-directory/useUserDirectorySearch'

/**
 * The outcome of the last attempt: why it failed, why it changed nothing, or who was just given
 * access, with the link to send them.
 */
export type InviteFeedback = { tone: 'error' | 'info' | 'success'; message: string }

type Props = {
  authenticatedApi: RpcStub<AuthenticatedApi>
  /** Whether the deployment's user directory can be searched. */
  searchEnabled: boolean
  /** Whether the current members have loaded; 'failed' falls back to direct invites. */
  membership: 'loading' | 'ready' | 'failed'
  /** People who are already on the workspace and so cannot be invited. */
  excludeIds: string[]
  value: string
  onValueChange: (value: string) => void
  action: 'Invite' | 'Share'
  adding: boolean
  feedback: InviteFeedback | null
  /** Where a new recipient opens what they were given, offered once they are added. */
  link: { copied: boolean; onCopy: () => void }
  onInvite: (userId: string) => void
  inputRef: Ref<HTMLInputElement>
}

/** Invites one person at a time: Enter, choosing a result, or Invite submits immediately. */
export const InviteComposer = ({
  authenticatedApi,
  searchEnabled,
  membership,
  excludeIds,
  value,
  onValueChange,
  action,
  adding,
  feedback,
  link,
  onInvite,
  inputRef,
}: Props) => {
  const feedbackId = useId()
  // The result popover is dismissed when focus leaves the combobox or on Escape; typing or
  // refocusing brings it back. The query and its search survive a dismissal.
  const [dismissed, setDismissed] = useState(true)
  const [highlightedUser, setHighlightedUser] = useState<UserDirectoryRecord | null>(null)
  const query = value.trim()
  const searching = searchEnabled && membership === 'ready' && !adding && query !== ''
  // Parents derive the exclusions during render; the search is keyed by identity, so equal
  // contents must not restart it.
  const excludeKey = JSON.stringify(excludeIds)
  const searchDirectory = useCallback((text: string) =>
    authenticatedApi.searchUsers(text, JSON.parse(excludeKey)), [authenticatedApi, excludeKey])
  const search = useUserDirectorySearch({ query, enabled: searching, search: searchDirectory })
  const noMatches = search.settled && search.status === 'ready' && search.results.length === 0
  const open = searching && !dismissed && !noMatches
  // Once the search has settled, the typed text can always be submitted as a canonical id: the
  // directory is a lazily backfilled convenience, so a valid id may be missing from it (or
  // shadowed by unrelated substring matches), and a directory outage must not block invites.
  // A membership-load failure also falls back to the authoritative direct-invite path.
  const canSubmit = query !== '' && (!searchEnabled ||
    (membership !== 'loading' && (membership === 'failed' || search.settled)))
  // Only settled results can be confirmed with the keyboard or the Invite button.
  const highlightedId = open && search.settled && highlightedUser &&
    search.results.some(user => user.id === highlightedUser.id)
    ? highlightedUser.id
    : null

  const invite = (userId: string) => {
    setDismissed(true)
    onInvite(userId)
  }

  // Confirming a highlighted result only fills the field, so what will be invited is visible;
  // confirming again, with nothing highlighted, sends it.
  const submit = () => {
    if (highlightedId) {
      onValueChange(highlightedId)
      setDismissed(true)
    } else if (canSubmit) {
      invite(query)
    }
  }

  const inviteLabel = adding ? (action === 'Invite' ? 'Inviting…' : 'Sharing…') : action
  // Keep the visible result highlighted until the click handler chooses it.
  const keepResultHighlighted = (event: MouseEvent) => {
    if (open) event.preventDefault()
  }

  return (
    <div className="sticky top-0 z-10 bg-kumo-base pb-3 pt-0.5">
      <Autocomplete<UserDirectoryRecord>
        items={search.results}
        filter={null}
        autoHighlight="always"
        openOnInputClick
        open={open}
        onOpenChange={(nextOpen) => setDismissed(!nextOpen)}
        value={value}
        readOnly={adding}
        itemToStringValue={(user) => user.id}
        onItemHighlighted={(user) => setHighlightedUser(user ?? null)}
        onValueChange={(next, { reason }) => {
          if (reason === 'escape-key') return
          if (reason === 'item-press') {
            invite(next)
            return
          }
          // Feedback describes what was typed, so only a real edit may clear it.
          if (next !== value) onValueChange(next)
          setDismissed(false)
        }}
      >
        <AutocompletePrimitive.InputGroup render={<InputGroup
          data-testid="people-composer"
          className="h-11 gap-2 rounded-2xl border-0 bg-kumo-elevated py-1 pr-1 shadow-none ring-1 ring-inset ring-kumo-line focus-within:ring-kumo-ring/60 has-[input[aria-invalid=true]]:ring-[1.5px] has-[input[aria-invalid=true]]:ring-kumo-danger"
          data-keeper-ignore="true"
          data-1p-ignore="true"
          data-lpignore="true"
          data-bwignore="true"
        />}>
          <AutocompletePrimitive.Input
            ref={inputRef}
            render={<InputGroup.Input />}
            type="search"
            placeholder={searchEnabled ? 'Add people by name or email' : 'Add people by username or email'}
            aria-label={searchEnabled ? 'Search people' : 'Username or email'}
            aria-invalid={feedback?.tone === 'error'}
            aria-describedby={feedback ? feedbackId : undefined}
            onFocus={() => setDismissed(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !isImeComposing(event)) {
                event.preventDefault()
                event.preventBaseUIHandler()
                submit()
              }
            }}
            name="gadget-share-people-search"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            data-keeper-ignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
            data-form-type="other"
            className="pl-1.5 text-[14px] [&::-webkit-search-cancel-button]:hidden"
          />
          <InputGroup.Addon align="end">
            <button
              type="button"
              className={roundButtonClass('pill', 'hidden !h-[34px] sm:inline-flex')}
              onMouseDown={keepResultHighlighted}
              onClick={submit}
              disabled={!canSubmit || adding}
            >
              {inviteLabel}
            </button>
          </InputGroup.Addon>
        </AutocompletePrimitive.InputGroup>
        {/* Keep loading and error feedback visible while there are no suggestion items. */}
        <Autocomplete.Content className="flex">
          <Autocomplete.Empty>
            <p role="status" className={`px-3 py-2 text-[12px] ${search.status === 'failed' ? 'text-kumo-danger' : 'text-kumo-subtle'}`}>
              {search.status === 'failed' ? 'User search is temporarily unavailable.' : 'Searching…'}
            </p>
          </Autocomplete.Empty>
          <Autocomplete.List aria-label="Matching people" aria-busy={search.status === 'loading'}>
            {(user: UserDirectoryRecord) => (
              <Autocomplete.Item key={user.id} value={user}>
                <div className="flex min-w-0 items-center gap-2">
                  <PersonAvatar api={authenticatedApi} userId={user.id} name={user.name} size={26} />
                  <span className="min-w-0 text-sm text-kumo-default">
                    <span className="block truncate font-medium">{user.name}</span>
                    <span className="block truncate text-xs text-kumo-subtle">{user.id}</span>
                  </span>
                </div>
              </Autocomplete.Item>
            )}
          </Autocomplete.List>
        </Autocomplete.Content>
      </Autocomplete>
      {feedback?.tone === 'info' && (
        <div id={feedbackId} role="status" className="mt-2">
          <p className="flex items-start gap-2 rounded-2xl bg-kumo-tint px-3 py-2 text-[13px] leading-[18px] text-kumo-default">
            <InfoIcon weight="fill" size={16} className="mt-px shrink-0 text-kumo-subtle" aria-hidden="true" />
            {feedback.message}
          </p>
        </div>
      )}
      {feedback?.tone === 'success' && (
        <div id={feedbackId} role="status" className="mt-2 flex items-center gap-2.5 rounded-2xl bg-kumo-tint py-2 pl-3 pr-2">
          <CheckCircleIcon weight="fill" size={16} className="shrink-0 text-kumo-success" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium leading-[18px] text-kumo-default">{feedback.message}</span>
            <span className="block text-[12px] leading-4 text-kumo-subtle">Send them the link so they can open it.</span>
          </span>
          <button type="button" className={roundButtonClass('pill', '!h-7 !px-2.5 !text-[12px]')} onClick={link.onCopy}>
            {link.copied ? <CheckIcon weight="bold" size={12} /> : <LinkIcon size={12} />}{link.copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}
      {feedback?.tone === 'error' && (
        <p id={feedbackId} role="alert" className="mt-1.5 flex items-start gap-1.5 break-words px-1 text-xs text-kumo-danger">
          <WarningCircleIcon weight="fill" className="mt-px shrink-0" aria-hidden="true" />
          {feedback.message}
        </p>
      )}
      {/* On narrow screens the input has no room for the button, so it sits beneath it. */}
      <button
        type="button"
        className="mt-2 inline-flex h-10 w-full cursor-pointer items-center justify-center rounded-full bg-kumo-contrast text-[14px] font-medium text-kumo-inverse disabled:opacity-40 sm:hidden"
        onMouseDown={keepResultHighlighted}
        onClick={submit}
        disabled={!canSubmit || adding}
      >
        {inviteLabel}
      </button>
    </div>
  )
}
