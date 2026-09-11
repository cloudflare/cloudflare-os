import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, UserDirectoryRecord } from '@gadgets/workshop-shared/api'
import { PersonAvatar } from './components/PersonAvatar'
import { isImeComposing } from './keyboardEvent'

/** Observable state of the current debounced directory search. */
export type UserSearchState = {
  status: 'loading' | 'failed' | 'ready'
  query: string
  resultCount: number
}

const EMPTY_SEARCH: UserSearchState = { status: 'ready', query: '', resultCount: 0 }

type Props = {
  /** Used only to render each result's avatar. */
  authenticatedApi: RpcStub<AuthenticatedApi>
  value: string
  /** True once the caller has accepted a result; hides the listbox until the text changes. */
  selected: boolean
  disabled?: boolean
  inputName: string
  search: (query: string) => Promise<UserDirectoryRecord[]>
  onValueChange: (value: string) => void
  onSelect: (user: UserDirectoryRecord) => void
  /** Enter with no highlighted result. */
  onSubmit: () => void
  onSearchStateChange?: (state: UserSearchState) => void
}

/** Debounced, keyboard-accessible Workshop user-directory combobox. */
export function UserSearchCombobox({
  authenticatedApi,
  value,
  selected,
  disabled = false,
  inputName,
  search,
  onValueChange,
  onSelect,
  onSubmit,
  onSearchStateChange,
}: Props) {
  const [searchState, setSearchState] = useState<UserSearchState>(EMPTY_SEARCH)
  const [results, setResults] = useState<UserDirectoryRecord[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const listboxId = useId()
  const activeOptionRef = useRef<HTMLButtonElement>(null)

  const query = value.trim()
  const open = !selected && query !== ''

  useEffect(() => {
    const update = (state: UserSearchState, users: UserDirectoryRecord[]) => {
      setResults(users)
      setSearchState(state)
      onSearchStateChange?.(state)
    }
    if (disabled || !open) {
      update(EMPTY_SEARCH, [])
      return
    }
    let cancelled = false
    update({ status: 'loading', query, resultCount: 0 }, [])
    setActiveIndex(0)
    // Debounced: every keystroke from every user would otherwise hit the one directory DO.
    const timer = window.setTimeout(() => {
      search(query).then(
        (users) => {
          if (!cancelled) update({ status: 'ready', query, resultCount: users.length }, users)
        },
        (error) => {
          if (cancelled) return
          console.error('Failed to search user directory:', error)
          update({ status: 'failed', query, resultCount: 0 }, [])
        },
      )
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [disabled, onSearchStateChange, open, query, search])

  useLayoutEffect(() => {
    if (open) activeOptionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open, results])

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return
    if (event.key === 'Enter') {
      event.preventDefault()
      const user = open ? results[activeIndex] : undefined
      if (user) onSelect(user)
      else onSubmit()
      return
    }
    if (open && results.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex(current => (current + direction + results.length) % results.length)
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <input
        type="search"
        role="combobox"
        placeholder="Search by name or email"
        aria-label="Search people"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && results[activeIndex]
          ? `${listboxId}-option-${activeIndex}`
          : undefined}
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={handleKeyDown}
        name={inputName}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        data-keeper-ignore="true"
        data-1p-ignore="true"
        data-lpignore="true"
        data-bwignore="true"
        data-form-type="other"
        className="h-9 w-full min-w-0 appearance-none border-0 bg-transparent p-0 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:hidden"
        disabled={disabled}
      />
      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Matching people"
          aria-busy={searchState.status === 'loading'}
          className="themed-floating-shadow-lg absolute left-0 top-full z-30 mt-2 max-h-64 w-full overflow-y-auto rounded-2xl border border-kumo-line/70 bg-kumo-base p-2 sm:w-96"
        >
          {searchState.status === 'loading' ? (
            <p role="status" className="px-3 py-2 text-[12px] text-kumo-subtle">Searching…</p>
          ) : searchState.status === 'failed' ? (
            <p role="status" className="px-3 py-2 text-[12px] text-kumo-danger">
              User search is temporarily unavailable.
            </p>
          ) : results.length === 0 ? (
            <p role="status" className="px-3 py-2 text-[12px] text-kumo-subtle">No users found.</p>
          ) : results.map((user, index) => (
            <button
              key={user.id}
              ref={index === activeIndex ? activeOptionRef : undefined}
              id={`${listboxId}-option-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(user)}
              className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ${
                index === activeIndex ? 'bg-kumo-tint' : 'hover:bg-kumo-tint/70'
              }`}
            >
              <PersonAvatar api={authenticatedApi} userId={user.id} name={user.name} size={32} />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium text-kumo-default">
                  {user.name}
                </span>
                <span className="block truncate font-mono text-[11px] text-kumo-subtle">
                  {user.id}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
