import { useEffect, useId, useState, type ReactNode } from 'react'
import { Dialog as BaseDialog } from '@cloudflare/kumo/primitives/dialog'
import { cn } from '@cloudflare/kumo/utils'
import { MagnifyingGlassIcon } from '@phosphor-icons/react'
import { searchMatches, type Searchable } from './searchMatches'
import '@/components/Dialog.css'

/** One thing search can go to. */
export type SearchEntry = Searchable & {
  key: string
  /** The heading it is listed under: "Go to", "Workspaces". */
  group: string
  /** A few words after the title, such as when it was last active. */
  detail?: string
  icon: ReactNode
  onSelect: () => void
}

export type SearchDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Everything that can be found. */
  entries: readonly SearchEntry[]
  /** What is offered before anything is typed, such as the most recent of `entries`. */
  suggested: readonly SearchEntry[]
  placeholder?: string
}

// Under each heading, so that one long group does not push the others out of sight.
const PER_GROUP = 8

const grouped = (entries: readonly SearchEntry[]) => {
  const groups = new Map<string, SearchEntry[]>()
  for (const entry of entries) {
    const group = groups.get(entry.group) ?? []
    if (group.length < PER_GROUP) groups.set(entry.group, [...group, entry])
  }
  return [...groups]
}

/**
 * Going anywhere by typing its name: a field, and beneath it what fits, best first, under the
 * heading of what each is; the group with the best fit comes first. The arrow keys move through
 * them and Enter goes to the one marked, as does a click. It comes and goes as a dialog does
 * (`Dialog.css`), nearer the top so that what it finds has room beneath.
 */
export const SearchDialog = ({ open, onOpenChange, entries, suggested, placeholder = 'Search' }: SearchDialogProps) => {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const listId = useId()

  const found = query.trim() ? searchMatches(query, entries) : suggested
  const groups = grouped(found)
  const shown = groups.flatMap(([, group]) => group)
  const current = Math.min(active, shown.length - 1)
  const optionId = (index: number) => `${listId}-${index}`

  // The marked one kept in sight as the keys move it.
  useEffect(() => {
    if (current >= 0) document.getElementById(optionId(current))?.scrollIntoView({ block: 'nearest' })
  })

  const go = (entry: SearchEntry | undefined) => {
    if (!entry) return
    onOpenChange(false)
    entry.onSelect()
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
      }}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="dialog-backdrop fixed inset-0 z-50 bg-black/20 dark:bg-black/50" />
        <BaseDialog.Viewport className="fixed inset-0 z-50 flex justify-center p-4 pt-[max(12vh,env(safe-area-inset-top))]">
          <BaseDialog.Popup
            className={cn(
              'dialog-popup flex h-fit max-h-full w-full max-w-xl flex-col overflow-hidden rounded-[28px] bg-kumo-base text-base/5 text-kumo-default outline-none',
              'shadow-[0_12px_40px_rgb(0_0_0/0.12)] ring-1 ring-kumo-contrast/6',
            )}
          >
            <BaseDialog.Title className="sr-only">Search</BaseDialog.Title>
            <div className="flex items-center gap-3 border-b border-kumo-line px-5">
              <MagnifyingGlassIcon aria-hidden="true" className="size-[1.125em] shrink-0 text-kumo-subtle" />
              <input
                role="combobox"
                aria-label="Search"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={current >= 0 ? optionId(current) : undefined}
                aria-autocomplete="list"
                value={query}
                placeholder={placeholder}
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="go"
                onChange={(event) => {
                  setQuery(event.target.value)
                  setActive(0)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    if (shown.length === 0) return
                    const step = event.key === 'ArrowDown' ? 1 : -1
                    setActive((current + step + shown.length) % shown.length)
                  } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    go(shown[current])
                  }
                }}
                className="h-14 min-w-0 flex-1 bg-transparent text-base text-kumo-default outline-none placeholder:text-kumo-subtle"
              />
            </div>
            <div id={listId} role="listbox" aria-label="Results" className="min-h-0 overflow-y-auto overscroll-contain p-2">
              {shown.length === 0 && (
                <p className="px-3 py-6 text-center text-kumo-subtle">
                  {query.trim() ? `Nothing matches “${query.trim()}”.` : 'Nothing to go to yet.'}
                </p>
              )}
              {groups.map(([group, members]) => (
                <div key={group} role="group" aria-label={group} className="not-first:mt-2">
                  <div aria-hidden="true" className="px-3 pt-2 pb-1 text-sm text-kumo-subtle">{group}</div>
                  {members.map((entry) => {
                    const at = index++
                    return (
                      <div
                        key={entry.key}
                        id={optionId(at)}
                        role="option"
                        aria-selected={at === current}
                        onPointerMove={() => at !== current && setActive(at)}
                        onClick={() => go(entry)}
                        className="flex cursor-pointer items-center gap-3 rounded-2xl px-3 py-2.5 aria-selected:bg-kumo-tint"
                      >
                        <span className="flex size-5 shrink-0 items-center justify-center text-kumo-subtle [&>svg]:size-[1.125em]">{entry.icon}</span>
                        <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                        {entry.detail && <span className="shrink-0 text-sm text-kumo-subtle">{entry.detail}</span>}
                      </div>
                    )
                  })}
                </div>
              ))}
            </div>
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  )
}
