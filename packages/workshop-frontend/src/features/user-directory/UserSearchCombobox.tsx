import {
  type KeyboardEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { RpcPromise, RpcStub } from 'capnweb'
import type { AuthenticatedApi, UserDirectoryRecord } from '@gadgets/workshop-shared/api'
import { PersonAvatar } from '../../components/PersonAvatar'
import { isImeComposing } from '../../keyboardEvent'
import { useUserDirectorySearch } from './useUserDirectorySearch'

/** Observable state of the current debounced directory search. */
export type UserSearchState = {
  status: 'loading' | 'failed' | 'ready'
  query: string
  resultCount: number
}

type Props = {
  /** Used only to render each result's avatar. */
  authenticatedApi: RpcStub<AuthenticatedApi>
  value: string
  /** True once the caller has accepted a result; hides the listbox until the text changes. */
  selected: boolean
  disabled?: boolean
  /** Disable directory lookup and accept only a typed exact identifier. */
  searchEnabled?: boolean
  inputName: string
  search: (query: string) => RpcPromise<UserDirectoryRecord[]>
  /** People hidden from results, such as ones chosen after the current search was issued. */
  excludeIds?: readonly string[]
  onValueChange: (value: string) => void
  onSelect: (user: UserDirectoryRecord) => void
  /** Submit a typed exact identifier when directory search is disabled. */
  onSubmit: () => void
  onSearchStateChange?: (state: UserSearchState) => void
}

/** Debounced, keyboard-accessible Workshop user-directory combobox. */
export function UserSearchCombobox({
  authenticatedApi,
  value,
  selected,
  disabled = false,
  searchEnabled = true,
  inputName,
  search,
  excludeIds,
  onValueChange,
  onSelect,
  onSubmit,
  onSearchStateChange,
}: Props) {
  const query = value.trim()
  const searching = searchEnabled && !disabled && !selected && query !== ''
  const directory = useUserDirectorySearch({ query, enabled: searching, search })
  const [dismissed, setDismissed] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const listboxId = useId()
  const activeOptionRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const open = searching && directory.current && !dismissed
  const results = excludeIds
    ? directory.results.filter(user => !excludeIds.includes(user.id))
    : directory.results
  const optionCount = results.length
  const searchState = useMemo<UserSearchState>(() => ({
    status: directory.status,
    query: directory.query,
    resultCount: results.length,
  }), [directory.query, directory.status, results.length])

  useEffect(() => {
    onSearchStateChange?.(searchState)
  }, [onSearchStateChange, searchState])

  useEffect(() => {
    setActiveIndex(0)
  }, [query, search, searching])

  const selectCurrentUser = (user: UserDirectoryRecord) => {
    if (open && inputRef.current?.value.trim() === query && results.includes(user)) onSelect(user)
  }

  const submitCurrentIdentifier = () => {
    if (!searchEnabled && !disabled && !selected && query !== '' &&
      inputRef.current?.value.trim() === query) onSubmit()
  }

  useLayoutEffect(() => {
    if (open) activeOptionRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex, open, directory.results, optionCount])

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled || isImeComposing(event)) return
    const inputCurrent = event.currentTarget.value.trim() === query
    if (event.key === 'Enter') {
      event.preventDefault()
      if (!inputCurrent || query === '') return
      const user = open ? results[activeIndex] : undefined
      if (user) selectCurrentUser(user)
      else submitCurrentIdentifier()
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      setDismissed(true)
      return
    }
    if (inputCurrent && searching && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      if (!open) {
        setDismissed(false)
        return
      }
      if (optionCount > 0) {
        const direction = event.key === 'ArrowDown' ? 1 : -1
        setActiveIndex(current => (current + direction + optionCount) % optionCount)
      }
    }
  }

  return (
    <div className="relative min-w-0 flex-1">
      <input
        ref={inputRef}
        type="search"
        role={searchEnabled ? 'combobox' : undefined}
        placeholder={searchEnabled ? 'Search by name or email' : 'Username or email'}
        aria-label={searchEnabled ? 'Search people' : 'Username or email'}
        aria-autocomplete={searchEnabled ? 'list' : undefined}
        aria-expanded={searchEnabled ? open : undefined}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex < optionCount
          ? `${listboxId}-option-${activeIndex}`
          : undefined}
        value={value}
        onChange={(event) => {
          setDismissed(false)
          onValueChange(event.target.value)
        }}
        onFocus={() => setDismissed(false)}
        onBlur={() => setDismissed(true)}
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
      {!searchEnabled && !disabled && !selected && query !== '' && (
        <button type="button" onClick={submitCurrentIdentifier} className="mt-2 text-[13px] underline">
          Select {query}
        </button>
      )}
      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-label="Matching people"
          aria-busy={searchState.status === 'loading'}
          className="mt-2 max-h-64 w-full overflow-y-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-2"
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
              tabIndex={-1}
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectCurrentUser(user)}
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
