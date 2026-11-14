import { useId, useState, type ReactNode, type Ref } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/Button'

export type InviteSuggestions = {
  /** Who matches what is typed, best first. */
  people: Array<{ id: string; name: string }>
  /** The search is out, for what is typed now. */
  searching: boolean
  failed: boolean
}

export type InviteFieldProps = {
  value: string
  onValueChange: (value: string) => void
  /** Gives access to whoever was typed or chosen, by their username or email. */
  onInvite: (userId: string) => void
  /** An invite is out: the field holds what was sent, and cannot send again. */
  pending: boolean
  /** The button's word: "Invite" to a workspace, "Share" a gadget. */
  action: 'Invite' | 'Share'
  /** People the deployment can be searched for, when it can be. */
  suggestions?: InviteSuggestions
  /** What the invited are given, chosen beside the button, such as Can use or Can view. */
  accessChoice?: ReactNode
  /** What was typed could not be invited; the feedback under the field says why. */
  invalid?: boolean
  /** The feedback under the field, which describes it. */
  describedBy?: string
  inputRef?: Ref<HTMLInputElement>
}

/**
 * A pill to add people by name, one at a time: Enter or the button sends what was typed. Where the
 * deployment can be searched, matches open under it as it is typed, moved through with the arrow
 * keys, and choosing one sends it.
 */
export const InviteField = ({
  value,
  onValueChange,
  onInvite,
  pending,
  action,
  suggestions,
  accessChoice,
  invalid,
  describedBy,
  inputRef,
}: InviteFieldProps) => {
  const listId = useId()
  const [focused, setFocused] = useState(false)
  // Put away with Escape, until something more is typed.
  const [dismissed, setDismissed] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const query = value.trim()
  const people = suggestions?.people ?? []
  const open = focused && !dismissed && !pending && query !== '' && suggestions !== undefined &&
    (people.length > 0 || suggestions.searching || suggestions.failed)
  const chosen = open && !suggestions?.searching ? people[Math.min(highlighted, people.length - 1)] : undefined
  const invite = (userId: string) => {
    setDismissed(true)
    onInvite(userId)
  }
  const submit = () => {
    if (pending) return
    if (chosen) invite(chosen.id)
    else if (query) invite(query)
  }
  const working = action === 'Invite' ? 'Inviting…' : 'Sharing…'

  return (
    <div className="relative">
      <div
        className={cn(
          'flex h-12 items-center gap-1 rounded-full bg-kumo-elevated ps-4 pe-1.5 ring-1 ring-kumo-line transition-shadow',
          'focus-within:ring-kumo-contrast/15',
          invalid && 'ring-kumo-danger/60 focus-within:ring-kumo-danger/60',
        )}
      >
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={chosen ? `${listId}-${chosen.id}` : undefined}
          aria-autocomplete={suggestions ? 'list' : 'none'}
          aria-label={suggestions ? 'Name, username or email' : 'Username or email'}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          // Shorter beside a choice of access, which takes some of its room.
          placeholder={`Add ${accessChoice ? '' : 'people '}by ${suggestions ? 'name' : 'username'} or email`}
          value={value}
          readOnly={pending}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="send"
          // Password managers otherwise offer to fill it, taking it for a sign-in field.
          data-1p-ignore=""
          data-lpignore="true"
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => {
            setDismissed(false)
            setHighlighted(0)
            onValueChange(event.target.value)
          }}
          onKeyDown={(event) => {
            // An IME's confirming Enter is for the IME.
            if (event.nativeEvent.isComposing || event.keyCode === 229) return
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            } else if (event.key === 'Escape' && open) {
              // Only the list: a second Escape is the dialog's.
              event.preventDefault()
              event.stopPropagation()
              setDismissed(true)
            } else if (open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              const step = event.key === 'ArrowDown' ? 1 : -1
              setHighlighted((current) => (current + step + people.length) % Math.max(people.length, 1))
            }
          }}
          className="h-full min-w-0 flex-1 bg-transparent text-base text-kumo-default outline-none placeholder:text-kumo-subtle"
        />
        {accessChoice}
        <Button variant="primary" disabled={pending || query === ''} onClick={submit} className="shrink-0">
          {pending ? working : action}
        </Button>
      </div>
      {open && (
        <div
          id={listId}
          role="listbox"
          aria-label="People who match"
          aria-busy={suggestions.searching || undefined}
          className="appears absolute inset-x-0 top-full z-10 mt-1.5 flex flex-col rounded-[21px] bg-kumo-base p-1.5 shadow-[0_8px_24px_rgb(0_0_0/0.08)] ring-1 ring-kumo-contrast/6"
        >
          {people.length === 0 && (
            <p role="status" className={cn('px-3 py-2.5 text-sm', suggestions.failed ? 'text-kumo-danger' : 'text-kumo-subtle')}>
              {suggestions.failed ? 'Searching isn’t available right now. Enter a username or email.' : 'Searching…'}
            </p>
          )}
          {people.map((person) => (
            <div
              key={person.id}
              id={`${listId}-${person.id}`}
              role="option"
              aria-selected={person === chosen}
              // Keeps focus in the field, which would otherwise close the list before the click.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setHighlighted(people.indexOf(person))}
              onClick={() => invite(person.id)}
              className="flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-2 text-base/5 aria-selected:bg-kumo-tint"
            >
              <Avatar name={person.name} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-kumo-default">{person.name}</span>
                <span className="truncate text-sm text-kumo-subtle">{person.id}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
