import { useRef, useState } from 'react'
import { CheckIcon, ListIcon, MagnifyingGlassIcon, SortAscendingIcon, SquaresFourIcon, XIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { Tooltip } from '@/components/Tooltip'

export type LibraryView = 'list' | 'grid'
export type LibraryOrder = 'recent' | 'name'

export type LibraryToolbarProps = {
  /** Offers the list or the grid; off for what is only ever a list. */
  views?: boolean
  view: LibraryView
  onViewChange: (view: LibraryView) => void
  sort: LibraryOrder
  onSortChange: (sort: LibraryOrder) => void
  query: string
  onQueryChange: (query: string) => void
}

const SORTS: Array<{ value: LibraryOrder; label: string }> = [
  { value: 'recent', label: 'Latest first' },
  { value: 'name', label: 'By name' },
]

/**
 * The Library's tools, in its header: a list or a grid, how it is ordered, and a search. The
 * search is a button until pressed, then grows to the left into a field where it was, and shrinks
 * back to a button when emptied and left, or on Escape.
 */
export const LibraryToolbar = ({ views = true, view, onViewChange, sort, onSortChange, query, onQueryChange }: LibraryToolbarProps) => {
  const inputRef = useRef<HTMLInputElement>(null)
  const [searching, setSearching] = useState(query !== '')
  const open = searching || query !== ''
  const close = () => {
    onQueryChange('')
    setSearching(false)
  }

  return (
    <div className="flex items-center gap-2">
      {/* On a phone the search takes their room while it is open, as they shrink away. */}
      <span
        className={cn(
          'flex items-center gap-2 transition-[width,opacity,margin] duration-200 ease-out motion-reduce:transition-none',
          views ? 'max-sm:w-[5.25rem]' : 'max-sm:w-9',
          open && 'max-sm:pointer-events-none max-sm:-me-2 max-sm:w-0 max-sm:overflow-hidden max-sm:opacity-0',
        )}
      >
        {views && (
          <Tooltip content={view === 'list' ? 'Show as a grid' : 'Show as a list'}>
            <Button
              icon={view === 'list' ? SquaresFourIcon : ListIcon}
              aria-label={view === 'list' ? 'Show as a grid' : 'Show as a list'}
              onClick={() => onViewChange(view === 'list' ? 'grid' : 'list')}
            />
          </Tooltip>
        )}
        <DropdownMenu icon={SortAscendingIcon} aria-label="Order" align="end">
          {SORTS.map(({ value, label }) => (
            <DropdownMenu.Item key={value} icon={sort === value ? CheckIcon : undefined} onSelect={() => onSortChange(value)} label={label}>
              <span className={cn(sort !== value && 'ps-7')}>{label}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu>
      </span>
      <div
        className={cn(
          'relative flex h-9 items-center overflow-hidden rounded-full bg-kumo-base ring-1 ring-kumo-line',
          // The dropdown menu's spring, so it grows as a menu does, a touch past and back.
          'transition-[width] duration-[420ms] ease-[linear(0,0.18_8%,0.53_18%,0.79_30%,0.94_43%,1.018_60%,1.012_74%,1)] motion-reduce:transition-none',
          open ? 'w-[min(16rem,calc(100vw-12rem))]' : 'w-9',
        )}
      >
        <button
          type="button"
          aria-label="Search"
          tabIndex={open ? -1 : 0}
          onClick={() => {
            setSearching(true)
            inputRef.current?.focus()
          }}
          className="absolute inset-y-0 start-0 flex w-9 items-center justify-center rounded-full text-kumo-default hover:bg-kumo-tint [&>svg]:size-[1.125em]"
        >
          <MagnifyingGlassIcon />
        </button>
        <input
          ref={inputRef}
          type="search"
          aria-label="Search the Library"
          placeholder="Search"
          value={query}
          tabIndex={open ? 0 : -1}
          onChange={(event) => onQueryChange(event.target.value)}
          onBlur={() => query === '' && setSearching(false)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            close()
            inputRef.current?.blur()
          }}
          className={cn(
            'h-full min-w-0 flex-1 bg-transparent ps-9 pe-2 text-base text-kumo-default outline-none placeholder:text-kumo-subtle [&::-webkit-search-cancel-button]:hidden',
            'transition-opacity duration-150',
            open ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
        />
        {query !== '' && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              onQueryChange('')
              inputRef.current?.focus()
            }}
            className="me-1 flex size-7 shrink-0 items-center justify-center rounded-full text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default [&>svg]:size-3.5"
          >
            <XIcon weight="bold" />
          </button>
        )}
      </div>
    </div>
  )
}
