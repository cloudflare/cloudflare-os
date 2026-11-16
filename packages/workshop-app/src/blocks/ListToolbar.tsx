import { Fragment, type ReactNode } from 'react'
import { FunnelSimpleIcon, RowsIcon, SortAscendingIcon, SquaresFourIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { OptionPicker } from '@/components/OptionPicker'
import { SearchField } from '@/components/SearchField'
import type { ListControls } from '@/components/listView'

export type ListToolbarProps = ListControls & {
  /** What is listed, in the plural, for the names of its controls: "workspaces". */
  noun: string
  /** What the list offers to do, such as making a new one: a button or a menu, at the end. */
  action?: ReactNode
  /**
   * Where the bar is: over its list, or under it at the bottom of a narrow screen, where it is
   * gathered in the middle and its menus open upwards. A menu given as `action` is the caller's to
   * open the same way.
   */
  at?: 'top' | 'bottom'
}

// Under the list the controls float over it as it scrolls by, so each is lifted off it by a shadow,
// soft and wide.
const LIFTED = 'shadow-[0_4px_16px_rgb(0_0_0/0.04)]'

// A dot at the button's edge while the list is narrowed, as the unread dot marks a workspace.
const NARROWED = "after:absolute after:top-0 after:right-0 after:size-2.5 after:rounded-full after:bg-kumo-brand after:ring-2 after:ring-kumo-base after:content-['']"

/**
 * The filters, as a menu: those that stand alone and each facet's alternatives are ticked in place,
 * a line between one facet and the next; a facet with a menu of its own (`facetMenus`) is an item
 * that opens it, with a field to find one of its alternatives by, and says how many of them are on.
 */
const FilterMenu = ({ value, options, facetMenus = {}, onChange, side, className }: NonNullable<ListControls['filter']> & { side: 'top' | 'bottom'; className?: string }) => {
  const set = (id: string, on: boolean) => onChange(on ? [...value, id] : value.filter((other) => other !== id))
  const inPlace = options.filter(({ facet }) => facet === undefined || !(facet in facetMenus))
  const menus = Object.entries(facetMenus)
    .map(([facet, label]) => ({ facet, label, options: options.filter((option) => option.facet === facet) }))
    .filter((menu) => menu.options.length > 0)

  return (
    <DropdownMenu
      icon={FunnelSimpleIcon}
      aria-label={value.length > 0 ? `Filter (${value.length} on)` : 'Filter'}
      triggerClassName={cn(value.length > 0 && NARROWED, className)}
      side={side}
      align="end"
      inPlace
    >
      <DropdownMenu.Label>Show only</DropdownMenu.Label>
      {inPlace.map(({ id, label, facet }, index) => (
        <Fragment key={id}>
          {index > 0 && (facet === undefined || facet !== inPlace[index - 1].facet) && <DropdownMenu.Separator />}
          <DropdownMenu.CheckboxItem checked={value.includes(id)} onCheckedChange={(on) => set(id, on)}>{label}</DropdownMenu.CheckboxItem>
        </Fragment>
      ))}
      {menus.length > 0 && inPlace.length > 0 && <DropdownMenu.Separator />}
      {menus.map((menu) => {
        const ids = menu.options.map(({ id }) => id)
        const on = value.filter((id) => ids.includes(id))
        return (
          <DropdownMenu.Submenu key={menu.facet} label={menu.label} detail={on.length > 0 ? on.length : undefined}>
            <OptionPicker
              aria-label={menu.label}
              options={menu.options}
              value={on}
              // The facet's own are replaced, and the others' left as they are.
              onValueChange={(next) => onChange([...value.filter((id) => !ids.includes(id)), ...next])}
            />
          </DropdownMenu.Submenu>
        )
      })}
      <DropdownMenu.Separator />
      {/* Always there, so that the menu keeps its size as filters are set. */}
      <DropdownMenu.Item disabled={value.length === 0} onSelect={() => onChange([])}>
        <span className={value.length === 0 ? 'text-kumo-inactive' : undefined}>Clear all</span>
      </DropdownMenu.Item>
    </DropdownMenu>
  )
}

/**
 * The controls of a list, on one line: the search at the start, which opens out over the room up
 * to the rest; then rows or cards, the order, the filters, and what the list offers to do. Each is
 * drawn only if given, so a list has the ones it has a use for. Over the list they are at its two
 * ends; under it (`at`), on a narrow screen, they are together in the middle.
 */
export const ListToolbar = ({ noun, search, view, order, filter, action, at = 'top' }: ListToolbarProps) => {
  const lifted = at === 'bottom' ? LIFTED : undefined
  return (
    <div className={cn('flex items-center gap-2', at === 'bottom' && 'justify-center')}>
      {search && <SearchField value={search.value} onValueChange={search.onChange} label={`Search ${noun}`} className={lifted} />}
      <div className={cn('flex shrink-0 items-center gap-2', at === 'top' && 'ms-auto')}>
        {view && (
          // It shows the view it goes to, as the button of a thing to do.
          view.value === 'list'
            ? <Button icon={SquaresFourIcon} aria-label="Show as cards" title="Show as cards" className={lifted} onClick={() => view.onChange('cards')} />
            : <Button icon={RowsIcon} aria-label="Show as a list" title="Show as a list" className={lifted} onClick={() => view.onChange('list')} />
        )}
        {order && (
          <DropdownMenu icon={SortAscendingIcon} aria-label="Sort" triggerClassName={lifted} side={at} align="end" inPlace>
            <DropdownMenu.Label>Sort by</DropdownMenu.Label>
            <DropdownMenu.RadioGroup value={order.value} onValueChange={order.onChange} aria-label="Sort by">
              {order.options.map(({ id, label }) => <DropdownMenu.RadioItem key={id} value={id}>{label}</DropdownMenu.RadioItem>)}
            </DropdownMenu.RadioGroup>
          </DropdownMenu>
        )}
        {filter && <FilterMenu {...filter} side={at} className={lifted} />}
        {/* The caller's, so lifted from around it: it is as round as a button is. */}
        {action && <span className={cn('flex rounded-full', lifted)}>{action}</span>}
      </div>
    </div>
  )
}
