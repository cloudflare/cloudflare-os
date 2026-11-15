import type { ReactElement, ReactNode } from 'react'
import { DotsThreeIcon, StarIcon, type Icon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { ContextMenu } from '@/components/ContextMenu'
import { DropdownMenu } from '@/components/DropdownMenu'
import type { FileThumbnail } from './file-preview/useFileThumbnail'
import { LinkButton } from '@/components/LinkButton'

/** Something that can be done with a thing in the Library, from its More menu or by right-clicking it. */
export type LibraryAction = {
  key: string
  label: string
  icon: Icon
  onSelect: () => void
}

/** What a Library row or tile shows, and what it does. */
export type LibraryItemProps = {
  title: string
  /** What kind of thing it is, shown when it has no picture of its own. */
  icon: ReactElement
  /** A picture of it, such as an image file's own, in place of its icon. */
  thumbnail?: string
  /**
   * A glimpse of it where it has no picture of its own: a gadget's screen, a document's first
   * page. A tile shows it under its name; a row, too small for one, shows its icon.
   */
  preview?: FileThumbnail | null
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

export const ACTION = 'text-kumo-subtle not-data-disabled:hover:bg-kumo-contrast/5 not-data-disabled:hover:text-kumo-default'

/** The items of a Library entry's menu, for its More menu and its right-click menu alike. */
export const libraryMenu = (actions: LibraryAction[]) =>
  actions.map(({ key, label, icon, onSelect }) => <DropdownMenu.Item key={key} icon={icon} onSelect={onSelect}>{label}</DropdownMenu.Item>)

/**
 * What a Library entry shows of itself in a row's icon place: its own picture, cut to a rounded
 * square, or the glyph of what it is.
 */
export const LibraryGlyph = ({ icon, thumbnail, className }: { icon: ReactElement; thumbnail?: string; className?: string }) =>
  thumbnail
    ? <img src={thumbnail} alt="" className={cn('size-5 shrink-0 rounded-[5px] object-cover ring-1 ring-kumo-contrast/6', className)} />
    : <span className={cn('flex shrink-0 text-kumo-default [&>svg]:size-5', className)}>{icon}</span>

/**
 * One of the row's buttons at its end, which slides out from under the edge, pushing the time in,
 * while the row is pointed at or has focus, or its menu is open; always out to a finger, and while
 * `shown`. As a workspace's row has (`WorkspaceRow`).
 */
const Action = ({ shown, children }: { shown?: boolean; children: ReactNode }) => (
  <span
    className={cn(
      'flex shrink-0 justify-end transition-[width,opacity] duration-75 ease-[cubic-bezier(0.2,0,0.15,1)] motion-reduce:transition-none',
      shown
        ? 'w-10 opacity-100'
        : 'pointer-events-none w-0 opacity-0 group-has-focus-visible:pointer-events-auto group-has-focus-visible:w-10 group-has-focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:w-10 group-hover:opacity-100 group-has-data-popup-open:pointer-events-auto group-has-data-popup-open:w-10 group-has-data-popup-open:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:w-10 pointer-coarse:opacity-100',
    )}
  >
    {children}
  </span>
)

/**
 * A gadget or a file in the Library, on one line: what it is (or its own picture), its name, and
 * when it was at the far end. Pointed at, More and its star slide out at the end; a starred one
 * keeps its star out, last, so that it stays where it is as More slides out before it. Right-click
 * it for the same menu as More.
 */
/** What a Library entry with changes waiting says of them: "3 to approve". */
export const WaitingLabel = ({ count, className }: { count: number; className?: string }) => (
  <span className={cn('flex shrink-0 items-center gap-1.5 text-kumo-warning', className)}>
    <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-kumo-warning" />
    {count} to approve
  </span>
)

export const LibraryRow = ({ title, icon, thumbnail, time, waiting, starred, onStarredChange, actions, href, onSelect }: LibraryItemProps) => (
  <ContextMenu menu={libraryMenu(actions)} aria-label={`More for ${title}`} className="block">
    <div className="group relative flex items-center rounded-2xl pr-1.5 hover:bg-kumo-contrast/5 has-focus-visible:bg-kumo-contrast/5 has-data-popup-open:bg-kumo-contrast/5">
      <LinkButton
        href={href}
        onClick={onSelect}
        // The whole row opens it, apart from the buttons over it.
        className="flex min-w-0 flex-1 items-center gap-3 rounded-2xl py-3 pr-2.5 pl-3 text-left text-base after:absolute after:inset-0 after:content-['']"
      >
        <LibraryGlyph icon={icon} thumbnail={thumbnail} />
        <span className="min-w-0 flex-1 truncate font-medium text-kumo-default">{title}</span>
        {waiting ? <WaitingLabel count={waiting} /> : time && <span className="shrink-0 text-end text-kumo-subtle">{time}</span>}
      </LinkButton>
      {actions.length > 0 && (
        <Action>
          <span className="relative flex">
            <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${title}`} triggerVariant="ghost" triggerClassName={ACTION} align="end">
              {libraryMenu(actions)}
            </DropdownMenu>
          </span>
        </Action>
      )}
      {starred !== undefined && onStarredChange && (
        <Action shown={starred}>
          <Button
            variant="ghost"
            icon={<StarIcon weight={starred ? 'fill' : 'regular'} />}
            aria-label={`Star ${title}`}
            aria-pressed={starred}
            onClick={() => onStarredChange(!starred)}
            className={cn('relative', ACTION)}
          />
        </Action>
      )}
    </div>
  </ContextMenu>
)
