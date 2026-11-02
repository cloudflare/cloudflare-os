import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { UserPlus, X } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi } from '@gadgets/workshop-shared/api'
import { PersonAvatar } from './PersonAvatar'
import { isImeComposing } from '../keyboardEvent'
import { useServerConfig } from '../ServerConfigContext'
import { useUserDirectorySearch } from '../features/user-directory/useUserDirectorySearch'

/**
 * A person queued in the composer but not yet submitted. `error` is set when submitting them
 * failed, so their chip stays for correction while everyone else's goes through.
 */
export type StagedPerson = { id: string; name: string; error?: string }

/**
 * The people suggestions must leave out (whoever is already there), and whether the caller has
 * loaded them yet. With user search on, nothing is searched or staged while they are `loading`,
 * since a suggestion could be someone already there. Once they have `failed` to load, the directory
 * is skipped and typed text is taken as an id, so the outage does not block adding people.
 *
 * `ids` must keep its identity while its contents are unchanged, so memoize it: a new array
 * restarts the search, and one built on every render would restart it without end.
 */
export type ExcludedPeople =
  | { status: 'loading' | 'failed' }
  | { status: 'ready'; ids: readonly string[] }

type DirectorySearch = ReturnType<typeof useUserDirectorySearch>
const NO_EXCLUDED_IDS: readonly string[] = []

/** `list` with `person` appended, unless they are already in it. */
export const withPerson = (list: StagedPerson[], person: StagedPerson): StagedPerson[] =>
  list.some(entry => entry.id === person.id) ? list : [...list, person]

// "Name (id)" when they differ, so two accounts with one display name stay tellable apart.
const personLabel = ({ id, name }: StagedPerson): string =>
  name === id ? name : `${name} (${id})`

type PeopleComposerOptions = {
  api: RpcStub<AuthenticatedApi>
  /**
   * The chips. The caller owns the list and settles it after a submit: dropping whoever went
   * through and setting `error` on whoever did not.
   */
  people: StagedPerson[]
  /** May name someone already in `people`; `withPerson` keeps the list free of duplicates. */
  onPersonAdd: (person: StagedPerson) => void
  onPersonRemove: (person: StagedPerson) => void
  excluded: ExcludedPeople
  /**
   * A submit is in flight. More people can be staged meanwhile (they wait for the next one) but
   * none removed, since a call already issued cannot be cancelled.
   */
  pending: boolean
  /** Enter on an empty field with people staged: the keyboard's way to send them. */
  onSubmit: () => void
  /**
   * What is announced when a person is queued as a chip, and when a chip is taken away, given
   * the person's label. The words are the caller's, because they must not be taken for what its
   * submit does: where the submit itself adds people, a chip is not yet an addition.
   */
  announce: { staged: (label: string) => string; unstaged: (label: string) => string }
}

// What `PeopleComposer` renders from, beyond what its caller reads off the controller.
type PeopleComposerField = {
  api: RpcStub<AuthenticatedApi>
  userSearchEnabled: boolean
  people: StagedPerson[]
  pending: boolean
  text: string
  query: string
  directory: DirectorySearch
  activeIndex: number
  optionCount: number
  notice: string
  inputRef: RefObject<HTMLInputElement | null>
  onTextChange: (text: string) => void
  onResultsDismissedChange: (dismissed: boolean) => void
  onActiveIndexChange: (index: number) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
  onRemove: (person: StagedPerson) => void
}

/** The composer's state, as its caller reads it to lay out the dialog and to submit. */
export type PeopleComposerController = {
  /**
   * The result list is showing. It is positioned against the field from outside the dialog's
   * scrolling body, so the caller stops that body scrolling for as long as this holds and the
   * composer is rendered.
   */
  resultsOpen: boolean
  /**
   * What the field holds besides the chips: the highlighted result, else the typed text once it
   * can be staged. A submit that sends the draft stages it first, which clears the field. The
   * highlight lasts only while the field has focus, so a control that submits the draft must not
   * take focus on mouse down while `resultsOpen`.
   */
  draft: StagedPerson | null
  /** Everyone a submit would send: the chips plus the draft, counted once. */
  recipients: StagedPerson[]
  /**
   * False when there is nobody to send, and while the field holds text that cannot be staged yet
   * (its search is still pending): a submit then would silently drop the name.
   */
  canSubmit: boolean
  /**
   * Queues a person as a chip and clears the field for the next name. Focus stays in the field so
   * a run of names can be entered without reaching for the mouse.
   */
  stage: (person: StagedPerson) => void
  /** Empties the field and its announcement. The chips are the caller's to clear. */
  reset: () => void
  /** For `PeopleComposer` alone. */
  field: PeopleComposerField
}

/**
 * The state behind `PeopleComposer`. It lives in the caller, not the component, because the caller
 * renders from it too: the dialog body's scroll lock and the submit control sit outside the field.
 */
export const usePeopleComposer = ({
  api,
  people,
  onPersonAdd,
  onPersonRemove,
  excluded,
  pending,
  onSubmit,
  announce,
}: PeopleComposerOptions): PeopleComposerController => {
  const userSearchEnabled = useServerConfig()?.userSearchEnabled ?? false
  const [text, setText] = useState('')
  // Focus stays in the field when a chip is added or removed, so the change is announced here.
  const [notice, setNotice] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  // The result popover is dismissed when focus leaves the combobox or on Escape; typing or
  // refocusing brings it back. The query and its search survive a dismissal.
  const [dismissed, setDismissed] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)
  const query = text.trim()
  const callerExcludedIds = excluded.status === 'ready' ? excluded.ids : NO_EXCLUDED_IDS
  // Memoized because the search restarts whenever this array changes identity. Everyone already
  // staged is left out as well.
  const excludeIds = useMemo(
    () => [...callerExcludedIds, ...people.map(person => person.id)],
    [callerExcludedIds, people],
  )
  const searching = userSearchEnabled && excluded.status === 'ready' && query !== ''
  const search = useCallback((q: string) => api.searchUsers(q, excludeIds), [api, excludeIds])
  const directory = useUserDirectorySearch({ query, enabled: searching, search })
  const resultsOpen = searching && directory.current && !dismissed
  const directorySettled = directory.settled
  const showDirectOption = directory.status === 'ready' && directory.results.length > 0
  const optionCount = directory.results.length + (showDirectOption ? 1 : 0)
  // Once the search has settled, the typed text can always be staged as a canonical id: the
  // directory is a lazily backfilled convenience, so a valid id may be missing from it (or
  // shadowed by unrelated substring matches), and a directory outage must not block adding people.
  const canStage = query !== '' && (!userSearchEnabled ||
    (excluded.status !== 'loading' && (excluded.status !== 'ready' || directorySettled)))
  const highlightedUser = resultsOpen ? directory.results[activeIndex] : undefined
  const draft: StagedPerson | null = highlightedUser
    ? { id: highlightedUser.id, name: highlightedUser.name }
    : canStage ? { id: query, name: query } : null
  const recipients = draft ? withPerson(people, draft) : people
  const canSubmit = recipients.length > 0 && (query === '' || draft !== null)

  useEffect(() => {
    if (searching) setActiveIndex(0)
  }, [searching, query, search])

  const stage = (person: StagedPerson) => {
    const label = personLabel(person)
    setNotice(people.some(entry => entry.id === person.id)
      ? `${label} is already listed.`
      : announce.staged(label))
    onPersonAdd(person)
    setText('')
    inputRef.current?.focus({ preventScroll: true })
    setDismissed(true)
  }

  const remove = (person: StagedPerson) => {
    setNotice(announce.unstaged(personLabel(person)))
    onPersonRemove(person)
    inputRef.current?.focus({ preventScroll: true })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return
    if (event.key === 'Enter') {
      event.preventDefault()
      if (draft) stage(draft)
      else if (query === '' && people.length > 0) onSubmit()
      return
    }
    if (event.key === 'Backspace' && text === '' && people.length > 0 && !pending) {
      event.preventDefault()
      remove(people[people.length - 1])
      return
    }
    if (!searching) return
    if (event.key === 'Escape' && resultsOpen) {
      // Closes only the popover; the dialog would otherwise take the same keypress.
      event.preventDefault()
      event.stopPropagation()
      setDismissed(true)
      return
    }
    if (optionCount > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      if (!resultsOpen) {
        setDismissed(false)
        return
      }
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveIndex(current => (current + direction + optionCount) % optionCount)
    }
  }

  return {
    resultsOpen,
    draft,
    recipients,
    canSubmit,
    stage,
    reset: () => {
      setText('')
      setNotice('')
    },
    field: {
      api,
      userSearchEnabled,
      people,
      pending,
      text,
      query,
      directory,
      activeIndex,
      optionCount,
      notice,
      inputRef,
      onTextChange: setText,
      onResultsDismissedChange: setDismissed,
      onActiveIndexChange: setActiveIndex,
      onKeyDown: handleKeyDown,
      onRemove: remove,
    },
  }
}

/**
 * The control for choosing people to add to something: a field that searches the deployment's
 * user directory (or takes a username or email as typed when user search is off), its result
 * list, and the people chosen so far as removable chips, with the reason on any whose submit
 * failed. What happens to the chosen people is the caller's: `children` are its controls in the
 * field's row, such as a role picker and the submit button.
 */
export const PeopleComposer = ({ composer, resultsContainer, children }: {
  composer: PeopleComposerController
  /**
   * The layer the result list is rendered into: an element covering the dialog from inside it, so
   * the list stays in the dialog's accessibility tree, but outside its scrolling body, so opening
   * results cannot make the dialog itself scroll.
   */
  resultsContainer: HTMLElement | null
  children: ReactNode
}) => {
  const { resultsOpen, stage } = composer
  const {
    api,
    userSearchEnabled,
    people,
    pending,
    text,
    query,
    directory,
    activeIndex,
    optionCount,
    notice,
    inputRef,
    onTextChange,
    onResultsDismissedChange,
    onActiveIndexChange,
    onKeyDown,
    onRemove,
  } = composer.field
  const listboxId = useId()
  const activeOptionRef = useRef<HTMLButtonElement>(null)
  const listboxRef = useRef<HTMLDivElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)
  const activeOptionId = resultsOpen && activeIndex < optionCount
    ? `${listboxId}-option-${activeIndex}`
    : undefined

  // The anchor grows and shrinks as chips wrap (or a submit settles mid-search), so it is observed
  // as well as the viewport.
  useLayoutEffect(() => {
    if (!resultsOpen) return
    const anchor = anchorRef.current
    if (!anchor) return
    const position = () => {
      const listbox = listboxRef.current
      const dialog = listbox?.parentElement
      if (!listbox || !dialog) return
      const anchorRect = anchor.getBoundingClientRect()
      const dialogRect = dialog.getBoundingClientRect()
      listbox.style.left = `${anchorRect.left - dialogRect.left}px`
      listbox.style.top = `${anchorRect.bottom - dialogRect.top + 8}px`
      listbox.style.width = `${anchorRect.width}px`
      listbox.style.maxHeight = `${Math.max(0, Math.min(
        205,
        dialogRect.bottom - anchorRect.bottom - 20,
      ))}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(anchor)
    const viewport = window.visualViewport
    window.addEventListener('resize', position)
    viewport?.addEventListener('resize', position)
    viewport?.addEventListener('scroll', position)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      viewport?.removeEventListener('resize', position)
      viewport?.removeEventListener('scroll', position)
    }
  }, [resultsOpen])

  useLayoutEffect(() => {
    if (!resultsOpen) return

    const listbox = listboxRef.current
    const option = activeOptionRef.current
    if (!listbox || !option) return

    // scrollIntoView() also scrolls the dialog's ancestor scroller. Adjust only the result list so
    // keyboard navigation cannot move the dialog underneath its sticky search field.
    const listboxRect = listbox.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    if (optionRect.top < listboxRect.top) {
      listbox.scrollTop -= listboxRect.top - optionRect.top
    } else if (optionRect.bottom > listboxRect.bottom) {
      listbox.scrollTop += optionRect.bottom - listboxRect.bottom
    }
  }, [activeIndex, resultsOpen, directory.results])

  return (
    <>
      <div
        ref={anchorRef}
        data-testid="people-composer"
        className="themed-compact-shadow grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-2xl border border-kumo-line/80 bg-kumo-base p-1.5 pl-3 transition-[border-color,box-shadow] focus-within:border-kumo-fill sm:flex"
        data-keeper-ignore="true"
        data-1p-ignore="true"
        data-lpignore="true"
        data-bwignore="true"
      >
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
          <UserPlus size={15} weight="duotone" />
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {people.map(person => (
            <span
              key={person.id}
              title={person.error ?? (person.name !== person.id ? person.id : undefined)}
              className={`inline-flex max-w-full items-center gap-1 rounded-full border py-[3px] pl-2.5 pr-1 text-[11px] leading-4 font-medium tracking-[-0.1px] ${
                person.error
                  ? 'border-kumo-danger bg-kumo-danger-tint/40 text-kumo-danger'
                  : 'border-kumo-line bg-kumo-tint/70 text-kumo-default'
              }`}
            >
              <span className="truncate">{person.name}</span>
              {person.name !== person.id && (
                <span className="truncate font-mono text-[10px] text-kumo-subtle">{person.id}</span>
              )}
              <button
                type="button"
                aria-label={`Remove ${personLabel(person)}`}
                onClick={() => onRemove(person)}
                disabled={pending}
                className="grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded-full opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed"
              >
                <X size={10} weight="bold" />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            type="search"
            role={userSearchEnabled ? 'combobox' : undefined}
            placeholder={userSearchEnabled ? 'Search by name or email' : 'Username or email'}
            aria-label={userSearchEnabled ? 'Search people' : 'Username or email'}
            aria-autocomplete={userSearchEnabled ? 'list' : undefined}
            aria-expanded={userSearchEnabled ? resultsOpen : undefined}
            aria-controls={resultsOpen ? listboxId : undefined}
            aria-activedescendant={activeOptionId}
            value={text}
            onChange={(event) => {
              onTextChange(event.target.value)
              onResultsDismissedChange(false)
            }}
            onFocus={() => onResultsDismissedChange(false)}
            onBlur={() => onResultsDismissedChange(true)}
            onKeyDown={onKeyDown}
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
            className="h-9 min-w-0 grow basis-32 appearance-none border-0 bg-transparent p-0 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:hidden"
          />
        </div>
        {children}
        {resultsOpen && resultsContainer && createPortal(
          <div
            ref={listboxRef}
            id={listboxId}
            role="listbox"
            aria-label="Matching people"
            aria-busy={directory.status === 'loading'}
            // Pressing anywhere in the popover (an option, its padding, the scrollbar) must not
            // blur the combobox, which would dismiss the popover before the click lands.
            onMouseDown={(event) => event.preventDefault()}
            className="chat-panel themed-floating-shadow-lg pointer-events-auto absolute overscroll-contain overflow-y-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-2"
          >
            {directory.status === 'loading' ? (
              <p role="status" className="px-3 py-2 text-[12px] text-kumo-subtle">Searching…</p>
            ) : directory.status === 'failed' ? (
              <p role="status" className="px-3 py-2 text-[12px] text-kumo-danger">
                User search is temporarily unavailable.
              </p>
            ) : directory.results.length === 0 ? (
              <p role="status" className="px-3 py-2 text-[12px] text-kumo-subtle">No users found.</p>
            ) : (
              <>
                {directory.results.map((user, index) => (
                  <button
                    key={user.id}
                    ref={index === activeIndex ? activeOptionRef : undefined}
                    id={`${listboxId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseEnter={() => onActiveIndexChange(index)}
                    onClick={() => stage({ id: user.id, name: user.name })}
                    className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ${
                      index === activeIndex ? 'bg-kumo-tint' : 'hover:bg-kumo-tint/70'
                    }`}
                  >
                    <PersonAvatar api={api} userId={user.id} name={user.name} size={32} />
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
                <button
                  ref={activeIndex === directory.results.length ? activeOptionRef : undefined}
                  id={`${listboxId}-option-${directory.results.length}`}
                  type="button"
                  role="option"
                  aria-selected={activeIndex === directory.results.length}
                  onMouseEnter={() => onActiveIndexChange(directory.results.length)}
                  onClick={() => stage({ id: query, name: query })}
                  className={`mt-1 flex w-full items-center gap-3 rounded-xl border-t border-kumo-line/60 px-3 py-2 text-left ${
                    activeIndex === directory.results.length
                      ? 'bg-kumo-tint'
                      : 'hover:bg-kumo-tint/70'
                  }`}
                >
                  <UserPlus size={15} className="shrink-0 text-kumo-subtle" />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium text-kumo-default">
                      Add &ldquo;{query}&rdquo; exactly
                    </span>
                    <span className="block text-[11px] text-kumo-subtle">
                      Use the text as a username or email
                    </span>
                  </span>
                </button>
              </>
            )}
          </div>,
          resultsContainer,
        )}
      </div>
      <p role="status" aria-live="polite" className="sr-only">{notice}</p>
      {people.some(person => person.error) && (
        <p role="alert" className="mt-1.5 px-1 text-[12px] leading-4 text-kumo-danger">
          {people.filter(person => person.error).map(person => (
            <span key={person.id} className="block break-words">
              {personLabel(person)}: {person.error}
            </span>
          ))}
        </p>
      )}
    </>
  )
}
