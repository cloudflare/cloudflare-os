import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { Dialog as BaseDialog } from '@cloudflare/kumo/primitives/dialog'
import { cn } from '@cloudflare/kumo/utils'
import { ArrowLeftIcon, MagnifyingGlassIcon } from '@phosphor-icons/react'
import { SwitchIndicator } from '@/components/SwitchIndicator'
import { useHandler } from '@/hooks/useHandler'
import { carriedInto, searchMatches, type Searchable } from './searchMatches'

/** One thing search can go to, or do. */
export type SearchEntry = Searchable & {
  key: string
  /** The heading it is listed under: "Go to", "Workspaces". */
  group: string
  /** A few words after the title, such as when it was last active, or what a setting is set to. */
  detail?: string
  icon: ReactNode
  /**
   * What choosing it does. It may go on to a page of its own (`SearchPage`) by returning one, and
   * may take a while, by returning a promise. One that throws, or rejects, says why under the
   * field and is left open to try again.
   */
  onSelect: () => void | SearchPage | Promise<void | SearchPage>
  /**
   * It is left open once done, to show what it did: for a setting changed in place, whose entry
   * then says what it is set to now.
   */
  keepOpen?: boolean
  /**
   * It is an on/off setting, which is on or off now: a switch at the end of its row says so, as the
   * Settings page draws it, and choosing it flips it. Leave it `keepOpen` to see it flip. Any `detail`
   * is said before the switch, for what there is to say besides, such as that it is blocked.
   */
  on?: boolean
  /**
   * Its group's heading is not drawn, where all of the group's entries say so: for the first rows of
   * the empty state, which need no name, and take less room without one. The group keeps its name,
   * for whatever reads it aloud.
   */
  noHeading?: boolean
}

/**
 * Where an entry goes on to, in place of the list: a choice of its own, or one thing to type. Its
 * title names the field and its placeholder says what the page is for; the only other sign of
 * where it is is the way back beside the field. That is also Backspace in an empty field (not for
 * typing, where Backspace is for the text) and Escape. A page may go on to another, and each way
 * back is one page, to what was typed and marked before it. What was typed goes on into a list
 * page where it still finds some of it (`carriedInto`).
 */
export type SearchPage =
  | {
      kind: 'list'
      title: string
      placeholder?: string
      /** All of them are listed, however many, and found as anything is. */
      entries: readonly SearchEntry[]
    }
  | {
      kind: 'text'
      title: string
      placeholder?: string
      /** What is typed in the field to begin with, and selected. */
      initial: string
      type?: 'text' | 'email'
      /** Enter keeps an empty field as it keeps any other. */
      optional?: boolean
      /** Rejects with why it could not be kept. The dialog goes once it is. */
      onSubmit: (value: string) => Promise<void>
    }

export type SearchDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Everything that can be found. */
  entries: readonly SearchEntry[]
  /** What is offered before anything is typed, such as the most recent of `entries`. */
  suggested: readonly SearchEntry[]
  placeholder?: string
  /**
   * Some of what is searched is still being read, so that what is not found may only not be there
   * yet: it says so, rather than that nothing matches.
   */
  reading?: boolean
}

// Under each heading, so that one long group does not push the others out of sight.
const PER_GROUP = 8

const grouped = (entries: readonly SearchEntry[], perGroup: number) => {
  const groups = new Map<string, SearchEntry[]>()
  for (const entry of entries) {
    const group = groups.get(entry.group) ?? []
    if (group.length < perGroup) groups.set(entry.group, [...group, entry])
  }
  return [...groups]
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * Going anywhere, or changing anything, by typing its name: a field, and beneath it what fits, best
 * first, under the heading of what each is; the group with the best fit comes first. The arrow keys
 * move through them and Enter goes to the one marked, as does a click. It comes and goes as a
 * `Dialog` does, over the same dimmed page, but nearer the top, so that what it finds has room
 * beneath, and scrolling within a height of its own so that a long list does not make it as tall as
 * the window. An entry may go on to a page (`SearchPage`) to choose or type what it is set to.
 */
export const SearchDialog = ({ open, onOpenChange, entries, suggested, placeholder = 'Search', reading = false }: SearchDialogProps) => {
  const [query, setQuery] = useState('')
  const [active, setMarked] = useState(0)
  // Whether the pointer marked the one marked, which is then under it and in sight already.
  const pointed = useRef(false)
  const setActive = (index: number, byPointer = false) => {
    pointed.current = byPointer
    setMarked(index)
  }
  // The pages gone on to, the last the one shown, each with what was typed and marked before it.
  const [trail, setTrail] = useState<{ page: SearchPage; query: string; active: number }[]>([])
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  // Whether it is still open when something that took a while is done: it may have been put away.
  const isOpen = useHandler(() => open)
  // What had the focus before it opened, which has it back once it is put away.
  const openedFrom = useRef<Element | null>(null)
  useLayoutEffect(() => {
    if (open) openedFrom.current = document.activeElement
  }, [open])

  const page = trail.at(-1)?.page
  const list = page?.kind === 'list' ? page : undefined
  const text = page?.kind === 'text' ? page : undefined
  const found = query.trim() ? searchMatches(query, list ? list.entries : entries) : list ? list.entries : suggested
  const groups = text ? [] : grouped(found, list ? Infinity : PER_GROUP)
  const shown = groups.flatMap(([, group]) => group)
  const current = Math.min(active, shown.length - 1)
  const optionId = (index: number) => `${listId}-${index}`

  // The marked one kept in sight as the keys move it. Not as the pointer does: its scroll padding
  // and a group's first one's margin would scroll one at the edge under the pointer a little.
  useEffect(() => {
    if (current >= 0 && !pointed.current) document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' })
  })

  // What there is to change, ready to be typed over.
  useEffect(() => {
    if (text) inputRef.current?.select()
  }, [text])

  const goOn = (next: SearchPage) => {
    setTrail((pages) => [...pages, { page: next, query, active }])
    // What was typed carries on into a list it still narrows, rather than being forgotten.
    setQuery(next.kind === 'text' ? next.initial : carriedInto(query, next.entries))
    setActive(0)
    setProblem(undefined)
    inputRef.current?.focus()
  }

  // One page back, to what was typed and marked there, not to the start.
  const goBack = () => {
    const from = trail.at(-1)
    if (!from) return
    setTrail(trail.slice(0, -1))
    setQuery(from.query)
    setActive(from.active)
    setProblem(undefined)
    inputRef.current?.focus()
  }

  // Nothing else is asked of the dialog while one is under way.
  const attempt = async <T,>(action: () => T | Promise<T>): Promise<{ value: T } | undefined> => {
    setProblem(undefined)
    setPending(true)
    try {
      return { value: await action() }
    } catch (error) {
      if (isOpen()) setProblem(messageOf(error))
      return undefined
    } finally {
      setPending(false)
    }
  }

  const go = async (entry: SearchEntry | undefined) => {
    if (!entry || pending) return
    const done = await attempt(entry.onSelect)
    if (!done || !isOpen()) return
    if (done.value) goOn(done.value)
    else if (!entry.keepOpen) onOpenChange(false)
  }

  const submit = async (typing: Extract<SearchPage, { kind: 'text' }>) => {
    const value = query.trim()
    if (pending || (value === '' && !typing.optional)) return
    if ((await attempt(() => typing.onSubmit(value))) && isOpen()) onOpenChange(false)
  }

  let index = 0
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next) => onOpenChange(next)}
      // Empty again for next time, once it has gone rather than as it goes.
      onOpenChangeComplete={(next) => {
        if (next) return
        setQuery('')
        setActive(0)
        setTrail([])
        setProblem(undefined)
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="fixed inset-0 z-50 bg-kumo-canvas/80 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 motion-reduce:transition-none" />
        <BaseDialog.Viewport className="fixed inset-0 z-50 flex justify-center p-4 pt-[max(12vh,env(safe-area-inset-top))]">
          <BaseDialog.Popup
            // Not back to a scrolling region the pointer had focused: keys put away would draw its focus ring on it, as though it had been tabbed to.
            finalFocus={() => !(openedFrom.current instanceof HTMLElement && openedFrom.current.hasAttribute('data-scroll-focus'))}
            className={cn(
              'flex h-fit max-h-full w-full max-w-xl flex-col overflow-hidden rounded-3xl bg-kumo-base text-base/5 text-kumo-default ring-1 ring-kumo-contrast/6 outline-none',
              'transition-[opacity,scale] duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0 motion-reduce:transition-none',
            )}
          >
            <BaseDialog.Title className="sr-only">{page ? page.title : 'Search'}</BaseDialog.Title>
            <div className="flex items-center gap-3 border-b border-kumo-line px-5">
              {page
                ? (
                    <button
                      type="button"
                      aria-label="Back"
                      onClick={goBack}
                      className="-mx-1 flex shrink-0 cursor-pointer items-center rounded-full p-1 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default"
                    >
                      <ArrowLeftIcon aria-hidden="true" className="size-[1.125em]" />
                    </button>
                  )
                : <MagnifyingGlassIcon aria-hidden="true" className="size-[1.125em] shrink-0 text-kumo-subtle" />}
              <input
                ref={inputRef}
                {...(text
                  ? { type: text.type ?? 'text', 'aria-label': text.title }
                  : {
                      role: 'combobox',
                      'aria-label': page ? page.title : 'Search',
                      'aria-expanded': true,
                      'aria-controls': listId,
                      'aria-activedescendant': current >= 0 ? optionId(current) : undefined,
                      'aria-autocomplete': 'list',
                    })}
                value={query}
                placeholder={page ? page.placeholder : placeholder}
                autoComplete="off"
                spellCheck={false}
                enterKeyHint={text ? 'done' : 'go'}
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActive(0)
                  setProblem(undefined)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && page) {
                    // One page back, not out of the dialog.
                    event.preventDefault()
                    event.stopPropagation()
                    goBack()
                  } else if (event.key === 'Backspace' && list && query === '') {
                    event.preventDefault()
                    goBack()
                  } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !text) {
                    event.preventDefault()
                    if (shown.length === 0) return
                    const step = event.key === 'ArrowDown' ? 1 : -1
                    setActive((current + step + shown.length) % shown.length)
                  } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    if (text) void submit(text)
                    else void go(shown[current])
                  }
                }}
                className="h-14 min-w-0 flex-1 bg-transparent text-base text-kumo-default outline-none placeholder:text-kumo-subtle"
              />
            </div>
            {problem && <p role="alert" className="px-5 pt-3 text-kumo-danger">{problem}</p>}
            {text
              ? (
                  <p className="px-5 py-4 text-sm text-kumo-subtle">
                    Press Enter to save{text.optional ? ', or leave it empty to clear it' : ''}.
                  </p>
                )
              : (
                  <div
                    id={listId}
                    role="listbox"
                    aria-label="Results"
                    aria-busy={pending}
                    // So that clicking one leaves the field to type in, as a page or a setting that stays open goes on.
                    onMouseDown={(event) => event.preventDefault()}
                    className="max-h-[min(30rem,60vh)] min-h-0 scroll-p-2 overflow-y-auto overscroll-contain p-2"
                  >
                    {shown.length === 0 && (
                      <p className="px-3 py-6 text-center text-kumo-subtle">
                        {reading && !list
                          ? 'Looking…'
                          : query.trim() ? `Nothing matches “${query.trim()}”.` : list ? 'Nothing to choose from.' : 'Nothing to go to yet.'}
                      </p>
                    )}
                    {groups.map(([group, members]) => {
                      const headed = !members.every(({ noHeading }) => noHeading)
                      return (
                        <div key={group} role="group" aria-label={group} className="not-first:mt-2">
                          {headed && (
                            <div aria-hidden="true" className="px-3 pt-2 pb-1 text-sm text-kumo-subtle">{group}</div>
                          )}
                          {members.map((entry) => {
                            const at = index++
                            return (
                              <div
                                key={entry.key}
                                id={optionId(at)}
                                role="option"
                                aria-selected={at === current}
                                onPointerMove={() => at !== current && setActive(at, true)}
                                onClick={() => void go(entry)}
                                // Scrolled to from below, a group's first stops under its heading rather than hiding it.
                                className={cn('flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 aria-selected:bg-kumo-tint', headed && entry === members[0] && 'scroll-mt-9')}
                              >
                                <span className="flex size-5 shrink-0 items-center justify-center text-kumo-subtle [&>svg]:size-[1.125em]">{entry.icon}</span>
                                <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                                {entry.detail && <span className="max-w-[50%] shrink-0 truncate text-sm text-kumo-subtle">{entry.detail}</span>}
                                {entry.on !== undefined && (
                                  <>
                                    <SwitchIndicator checked={entry.on} />
                                    <span className="sr-only">{entry.on ? 'On' : 'Off'}</span>
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      )
                    })}
                  </div>
                )}
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
