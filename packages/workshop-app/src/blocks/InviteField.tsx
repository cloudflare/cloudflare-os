import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Avatar, Button, TextField } from '@gadgets/ui'

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
  /** What whoever is invited is given, to choose before the button, where there is a choice. */
  access?: ReactNode
  /** Nothing can be sent as it stands, such as with a choice that is not to be had. */
  disabled?: boolean
  /** What its button says, and says while it is under way, where it adds rather than invites. */
  action?: { label: string; pendingLabel: string }
}

/**
 * A field to add people by, one at a time: Enter or Invite sends what was typed. Where the
 * deployment can be searched, matches open under it as it is typed, as a menu does, moved through
 * with the arrow keys, and choosing one sends it.
 */
export const InviteField = ({ value, onValueChange, onInvite, pending, suggestions, invalid, describedBy, access, disabled, action = { label: 'Invite', pendingLabel: 'Inviting…' } }: InviteFieldProps) => {
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
  // Where the list is, held to the field as the window or what holds the field scrolls: fixed to
  // the window rather than in the dialog's scrolling body, which would cut it off at its foot and
  // grow to scroll what it covers. As tall as there is room for under the field, scrolled within.
  const anchor = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ top: number; left: number; width: number; maxHeight: number }>()
  useLayoutEffect(() => {
    if (!open) return
    const follow = () => {
      const box = anchor.current?.getBoundingClientRect()
      if (!box) return
      const top = box.bottom + 6
      setPlace({ top, left: box.left, width: box.width, maxHeight: Math.max(120, window.innerHeight - top - 16) })
    }
    follow()
    window.addEventListener('resize', follow)
    window.addEventListener('scroll', follow, true)
    return () => {
      window.removeEventListener('resize', follow)
      window.removeEventListener('scroll', follow, true)
    }
  }, [open])
  const invite = (userId: string) => {
    setDismissed(true)
    onInvite(userId)
  }
  const submit = () => {
    if (pending || disabled) return
    if (chosen) invite(chosen.id)
    else if (query) invite(query)
  }

  return (
    // On a narrow screen the field has a line to itself, with the choice and the button under its end.
    <div className="flex flex-wrap items-center justify-end gap-2">
      <div ref={anchor} className="relative min-w-0 flex-1 max-md:basis-full">
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
            // A menu's surface, under the field, over what follows it in the dialog and past its foot.
            style={place}
            className={cn('appears fixed z-50 flex flex-col overflow-y-auto overscroll-contain rounded-[21px] bg-kumo-base p-1.5 shadow-[0_12px_40px_rgb(0_0_0/0.12)] ring-1 ring-kumo-contrast/6', !place && 'invisible')}
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
      {access}
      <Button variant="primary" disabled={pending || disabled || query === ''} onClick={submit}>
        {pending ? action.pendingLabel : action.label}
      </Button>
    </div>
  )
}
