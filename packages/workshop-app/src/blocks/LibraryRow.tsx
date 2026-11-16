import type { ReactElement } from 'react'
import { DotsThreeIcon, type Icon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { ContextMenu } from '@/components/ContextMenu'
import { DropdownMenu } from '@/components/DropdownMenu'
import { LinkButton } from '@/components/LinkButton'
import { RowAction } from './RowAction'
import { LIST_ACTION, StarButton } from './StarButton'

/** Something that can be done with a thing in the Library, from its More menu or by right-clicking it. */
export type LibraryAction = {
  key: string
  label: string
  icon: Icon
  onSelect: () => void
}

/** What a Library row or card shows, and what it does. */
export type LibraryItemProps = {
  title: string
  /** A line under the title: what it is, which workspace it is in, and whose that is. */
  detail?: string
  /** What kind of thing it is, shown when it has no picture of its own. */
  icon: ReactElement
  /** A picture of it, such as an image file's own, filling its icon's place. */
  thumbnail?: string
  /** When it was, as the list it is in puts it. */
  time?: string
  /** How many changes it has waiting on the viewer to approve, said in place of when it was. */
  waiting?: number
  /** Starred or not; absent for what cannot be, such as a file that lives with a connected service. */
  starred?: boolean
  onStarredChange?: (starred: boolean) => void
  /** Its More menu, which right-clicking it opens as well. */
  actions: LibraryAction[]
  /** Where it opens, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/** How a button over a Library entry is drawn (`LIST_ACTION`), for the blocks that share its menu. */
export const ACTION = LIST_ACTION

/** The items of a Library entry's menu, for its More menu and its right-click menu alike. */
export const libraryMenu = (actions: LibraryAction[]) =>
  actions.map(({ key, label, icon, onSelect }) => <DropdownMenu.Item key={key} icon={icon} onSelect={onSelect}>{label}</DropdownMenu.Item>)

/**
 * What a Library entry shows of itself in its icon's place, a rounded square: its own picture
 * filling it, or the glyph of what it is on a fill.
 */
export const LibraryGlyph = ({ icon, thumbnail, className }: { icon: ReactElement; thumbnail?: string; className?: string }) =>
  thumbnail
    ? <img src={thumbnail} alt="" className={cn('size-10 shrink-0 rounded-xl object-cover ring-1 ring-kumo-contrast/6', className)} />
    : <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-fill text-kumo-subtle [&>svg]:size-5', className)}>{icon}</span>

/** What a Library entry with changes waiting says of them: "3 to approve". */
export const WaitingLabel = ({ count, className }: { count: number; className?: string }) => (
  <span className={cn('flex shrink-0 items-center gap-1.5 text-kumo-warning', className)}>
    <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-kumo-warning" />
    {count} to approve
  </span>
)

/** A Library entry's More menu, at its end or in its corner. */
export const LibraryMore = ({ title, actions, side }: { title: string; actions: LibraryAction[]; side?: 'top' | 'bottom' }) => (
  <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${title}`} triggerVariant="ghost" triggerClassName={LIST_ACTION} side={side} align="end">
    {libraryMenu(actions)}
  </DropdownMenu>
)

/**
 * A gadget or a file in the Library, on one line: what it is (or its own picture), its title over
 * where it is from, and at the far end when it was, or what waits on the viewer. Pointed at, More
 * and its star slide out at the end; a starred one keeps its star out, last, so that it stays where
 * it is as More slides out before it. Right-click it for the same menu as More.
 */
export const LibraryRow = ({ title, detail, icon, thumbnail, time, waiting, starred, onStarredChange, actions, href, onSelect }: LibraryItemProps) => (
  <ContextMenu menu={libraryMenu(actions)} aria-label={`More for ${title}`} className="block">
    <div className="group relative flex items-center rounded-2xl pr-1.5 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5">
      <LinkButton
        href={href}
        onClick={onSelect}
        // The whole row opens it, apart from the buttons over it.
        className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-3 pr-2.5 pl-3 text-left text-base after:absolute after:inset-0 after:content-['']"
      >
        <LibraryGlyph icon={icon} thumbnail={thumbnail} />
        <span className="min-w-0 flex-1 leading-snug">
          <span className="block truncate font-medium text-kumo-default">{title}</span>
          {detail && <span className="block truncate text-kumo-subtle">{detail}</span>}
        </span>
        {waiting ? <WaitingLabel count={waiting} /> : time && <span className="shrink-0 text-end text-kumo-subtle">{time}</span>}
      </LinkButton>
      {actions.length > 0 && (
        <RowAction>
          <span className="relative flex">
            <LibraryMore title={title} actions={actions} />
          </span>
        </RowAction>
      )}
      {starred !== undefined && onStarredChange && (
        <RowAction shown={starred}>
          <StarButton title={title} starred={starred} onStarredChange={onStarredChange} className="relative" />
        </RowAction>
      )}
    </div>
  </ContextMenu>
)
