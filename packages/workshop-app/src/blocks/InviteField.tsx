import { useId, useState } from 'react'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/Button'
import { TextField } from '@/components/TextField'

/** People who match what is typed in an `InviteField`. */
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
  /** People the deployment can be searched for, when it can be. */
  suggestions?: InviteSuggestions
  /** What was typed could not be invited; the note under the field says why. */
  invalid?: boolean
  /** The note under the field, which describes it. */
  describedBy?: string
}

/**
 * A field to add people by, one at a time: Enter or Invite sends what was typed. Where the
 * deployment can be searched, matches open under it as it is typed, as a menu does, moved through
 * with the arrow keys, and choosing one sends it.
 */
export const InviteField = ({ value, onValueChange, onInvite, pending, suggestions, invalid, describedBy }: InviteFieldProps) => {
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

  return (
    // On a narrow screen the field has a line to itself, with the choice and the button under its end.
    <div className="flex flex-wrap items-center justify-end gap-2">
      <div className="relative min-w-0 flex-1 max-md:basis-full">
        <TextField
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-activedescendant={chosen ? `${listId}-${chosen.id}` : undefined}
          aria-autocomplete={suggestions ? 'list' : 'none'}
          aria-label={suggestions ? 'Name, username or email' : 'Username or email'}
          aria-describedby={describedBy}
          invalid={invalid}
          placeholder={suggestions ? 'Name or email' : 'Username or email'}
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
          onValueChange={(next) => {
            setDismissed(false)
            setHighlighted(0)
            onValueChange(next)
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
        />
        {open && (
          <div
            id={listId}
            role="listbox"
            aria-label="People who match"
            aria-busy={suggestions.searching || undefined}
            // A menu's surface, under the field, over what follows it in the dialog.
            className="appears absolute inset-x-0 top-full z-10 mt-1.5 flex flex-col rounded-[21px] bg-kumo-base p-1.5 ring-1 ring-kumo-contrast/6"
          >
            {people.length === 0 && (
              <p role="status" className="px-(--menu-pad-x) py-(--menu-pad-y) text-sm text-kumo-subtle">
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
                className="flex cursor-pointer items-center gap-3 rounded-2xl px-(--menu-pad-x) py-2 text-(length:--menu-text) leading-snug aria-selected:bg-kumo-tint"
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
      <Button variant="primary" disabled={pending || query === ''} onClick={submit}>
        {pending ? 'Inviting…' : 'Invite'}
      </Button>
    </div>
  )
}
