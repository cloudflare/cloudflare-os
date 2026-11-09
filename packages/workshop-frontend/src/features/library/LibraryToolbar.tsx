import { useEffect, useRef, useState, type ReactNode } from 'react'
import { DropdownMenu } from '@cloudflare/kumo'
import { Check, ListBullets } from '@phosphor-icons/react'
import { RoundButton, roundButtonClass } from '../../components/RoundButton'
import { ChevronDownIcon, FilterIcon, LibraryIcon, SearchIcon, SortIcon } from '../../components/icons/designIcons'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from '../../components/menuStyles'
import type { LibraryLayout } from './LibraryViews'

/** How a Library orders its items. */
export type LibrarySort = 'recent' | 'name'

const SORTS: { value: LibrarySort; label: string }[] = [
  { value: 'recent', label: 'Most recent' },
  { value: 'name', label: 'Name' },
]

/** A choice in a Library's filter menu. */
export type LibraryFilterOption = { value: string; label: string }

function MenuButton({ label, icon, active, children }: {
  label: string
  icon: ReactNode
  active?: boolean
  children: ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={
        <button type="button" aria-label={label} title={label}
          className={roundButtonClass('icon', `relative max-md:!size-11 ${active ? '!bg-kumo-tint' : ''}`)}>
          {icon}
        </button>
      } />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} align="end">
        {children}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

function CheckItem({ checked, onClick, children }: { checked: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <DropdownMenu.Item onClick={onClick} className={MENU_ITEM}>
      <span className="flex-1">{children}</span>
      {checked && <Check size={12} className="text-kumo-subtle" />}
    </DropdownMenu.Item>
  )
}

/**
 * The search control (Figma "Navbar" 34×34): a round button that opens into a field in place, and
 * stays open while it holds a query.
 */
export function LibrarySearch({ query, onQueryChange, placeholder = 'Search' }: {
  query: string
  onQueryChange: (query: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(query !== '')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) inputRef.current?.focus() }, [open])
  if (!open) {
    return (
      <RoundButton label="Search" onClick={() => setOpen(true)} className="max-md:!size-11">
        <SearchIcon size={16} />
      </RoundButton>
    )
  }
  return (
    <label className="flex h-[34px] max-md:h-11 w-[min(220px,50vw)] shrink-0 items-center gap-2 rounded-full bg-kumo-base px-2.5 ring-1 ring-kumo-line focus-within:ring-2 focus-within:ring-kumo-ring">
      <SearchIcon size={16} className="shrink-0 text-kumo-subtle" />
      <input
        ref={inputRef}
        value={query}
        onChange={event => onQueryChange(event.target.value)}
        onBlur={() => { if (!query) setOpen(false) }}
        onKeyDown={event => {
          if (event.key === 'Escape') { onQueryChange(''); setOpen(false) }
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-kumo-default outline-none placeholder:text-kumo-subtle"
      />
    </label>
  )
}

/** The black "New" pill (Figma "Round Btn" 71×34) and its menu. */
export function NewMenuButton({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={
        <button type="button" className="inline-flex h-[34px] max-md:h-11 max-md:px-4 max-md:text-[15px] shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-kumo-contrast px-3 text-[13px] font-medium leading-4 text-kumo-inverse transition-opacity hover:opacity-85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring">
          New
          <ChevronDownIcon size={12} />
        </button>
      } />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} align="end">
        {children}
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}

/**
 * A Library's view controls (Figma "Frame 803"): list or grid, sort, filter. Search and New are
 * separate so a page can place them where its frame does.
 */
export function LibraryViewControls({
  layout,
  onLayoutChange,
  sort,
  onSortChange,
  filters,
  filter,
  onFilterChange,
}: {
  /** Leave both out for a view with no grid, such as Workspaces. */
  layout?: LibraryLayout
  onLayoutChange?: (layout: LibraryLayout) => void
  sort: LibrarySort
  onSortChange: (sort: LibrarySort) => void
  filters?: LibraryFilterOption[]
  filter?: string
  onFilterChange?: (filter: string) => void
}) {
  return (
    <>
      {layout && onLayoutChange && (
        <RoundButton
          label={layout === 'list' ? 'Show as grid' : 'Show as list'}
          onClick={() => onLayoutChange(layout === 'list' ? 'grid' : 'list')}
          className="max-md:!size-11"
        >
          {layout === 'list' ? <LibraryIcon size={16} /> : <ListBullets size={16} weight="light" />}
        </RoundButton>
      )}
      <MenuButton label="Sort" icon={<SortIcon size={16} />}>
        {SORTS.map(option => (
          <CheckItem key={option.value} checked={sort === option.value} onClick={() => onSortChange(option.value)}>
            {option.label}
          </CheckItem>
        ))}
      </MenuButton>
      {filters && filters.length > 0 && onFilterChange && (
        <MenuButton label="Filter" icon={<FilterIcon size={16} />} active={filter !== undefined && filter !== filters[0].value}>
          {filters.map(option => (
            <CheckItem key={option.value} checked={filter === option.value} onClick={() => onFilterChange(option.value)}>
              {option.label}
            </CheckItem>
          ))}
        </MenuButton>
      )}
    </>
  )
}

/** Orders and searches Library items by the toolbar's choices. */
export function arrangeLibraryItems<T extends { title: string; date: Date; context?: string }>(
  items: T[], sort: LibrarySort, query: string,
): T[] {
  const needle = query.trim().toLowerCase()
  const matching = needle
    ? items.filter(item => item.title.toLowerCase().includes(needle) ||
        item.context?.toLowerCase().includes(needle))
    : items
  return matching.toSorted(sort === 'name'
    ? (a, b) => a.title.localeCompare(b.title)
    : (a, b) => b.date.getTime() - a.date.getTime())
}
