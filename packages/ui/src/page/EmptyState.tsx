import type { ReactNode } from 'react'
import type { Icon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '../Button'
import { DropdownMenu } from '../menu/DropdownMenu'

/** Something to do about there being nothing: start the first one, or go where there is some. */
export type EmptyStateAction = {
  label: string
  icon?: Icon
  /** `primary` for the one thing the empty place asks for, at most one. */
  variant?: 'primary' | 'secondary'
} & (
  | { onClick: () => void; menu?: undefined }
  /** A menu of `DropdownMenu.Item`s to choose from, as where there are several things to start. */
  | { menu: ReactNode; onClick?: undefined }
)

export type EmptyStateProps = {
  /** What would be here, drawn on a tile. */
  icon: Icon
  /** A second, smaller mark on the tile's corner, for a kind of the first. */
  badge?: Icon
  /** What is missing, said in a few words: "No chats yet". */
  title: string
  /** What would be here and how it comes to be, in a sentence or two. */
  description?: string
  /** What can be done about it, in order, a `primary` one first. */
  actions?: readonly EmptyStateAction[]
  /**
   * `page` stands in for a whole page's list, centred in the room it is given (`PageLayout`'s
   * `fill`). `section` stands in for a tab, a group or a pane, and is smaller, as what is around it
   * says much of what it is.
   */
  size?: 'page' | 'section'
  /**
   * On the tinted surface a list of rows sits on (`bg-kumo-tint`), in that list's place, for one
   * among other things, such as a settings group, where it would otherwise not read as a place.
   */
  tinted?: boolean
  /**
   * It is on a tinted surface already, such as the side pane's. Its tile is then a fill, as a row's
   * icon is on a list, where the card's colour would look cut into the tint in dark mode.
   */
  onTint?: boolean
  /** Anything more to start from, under the actions, such as examples to try. */
  children?: ReactNode
  className?: string
}

const SIZE = {
  // Small text's own line height is a heading's, too tight for a sentence or two.
  page: { root: 'my-auto gap-5 px-4 py-10', tile: 'size-14', glyph: 'size-7', title: 'text-lg', description: 'max-w-md text-base', copy: '' },
  section: { root: 'gap-4 px-4 py-6', tile: 'size-12', glyph: 'size-6', title: 'text-base', description: 'max-w-sm text-sm', copy: 'leading-normal' },
} as const

/**
 * What a page, a tab or a pane shows while it has nothing to show: what would be here, in a title
 * and a sentence, and the way to have some, as Linear does. Kumo's `Empty` is a filled, outlined
 * card with a fixed heading, where this sits on whatever surface it is on in the app's own type.
 * Not for what is still loading or failed to: say that where it is.
 */
export const EmptyState = ({ icon: Glyph, badge: Badge, title, description, actions, size = 'page', tinted = false, onTint = tinted, children, className }: EmptyStateProps) => {
  const sized = SIZE[size]
  const Heading = size === 'page' ? 'h2' : 'h3'
  return (
    <div className={cn('mx-auto flex w-full flex-col items-center text-center', sized.root, tinted && 'rounded-3xl bg-kumo-tint py-10', className)}>
      <span aria-hidden="true" className={cn('relative grid shrink-0 place-items-center rounded-2xl text-kumo-subtle', onTint ? 'bg-kumo-fill' : 'bg-kumo-base ring-1 ring-kumo-line', sized.tile)}>
        <Glyph className={sized.glyph} />
        {Badge && (
          <span className={cn('absolute -right-1.5 -bottom-1.5 grid size-6 place-items-center rounded-full ring-1 ring-kumo-line', onTint ? 'bg-kumo-tint' : 'bg-kumo-base')}>
            <Badge weight="fill" className="size-3.5 text-kumo-default" />
          </span>
        )}
      </span>
      <div className={cn('flex flex-col items-center gap-1.5', sized.description)}>
        <Heading className={cn('font-medium text-balance text-kumo-default', sized.title)}>{title}</Heading>
        {description && <p className={cn('text-pretty text-kumo-subtle', sized.copy)}>{description}</p>}
      </div>
      {actions && actions.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {actions.map(({ label, icon, onClick, menu, variant = 'secondary' }) => menu
            ? <DropdownMenu key={label} label={label} icon={icon} caret triggerVariant={variant} align="center" inPlace>{menu}</DropdownMenu>
            : <Button key={label} variant={variant} icon={icon} onClick={onClick}>{label}</Button>)}
        </div>
      )}
      {children}
    </div>
  )
}
