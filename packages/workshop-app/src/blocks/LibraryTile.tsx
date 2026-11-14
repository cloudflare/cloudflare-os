import { DotsThreeIcon, StarIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { ContextMenu } from '@/components/ContextMenu'
import { DropdownMenu } from '@/components/DropdownMenu'
import { LinkButton } from '@/components/LinkButton'
import { libraryMenu, type LibraryItemProps } from './LibraryRow'

// Over a picture as much as over the tile's own surface, so on a disc of their own.
const BUTTON = 'size-7 rounded-full bg-kumo-base/85 text-kumo-default shadow-[0_1px_2px_rgb(0_0_0/0.08)] backdrop-blur-sm [&_svg]:size-3.5 not-data-disabled:hover:bg-kumo-base'

const REVEALED = 'opacity-100 scale-100'
const HIDDEN = 'pointer-events-none scale-75 opacity-0 group-hover:pointer-events-auto group-hover:scale-100 group-hover:opacity-100 group-has-focus-visible:pointer-events-auto group-has-focus-visible:scale-100 group-has-focus-visible:opacity-100 group-has-data-popup-open:pointer-events-auto group-has-data-popup-open:scale-100 group-has-data-popup-open:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:scale-100 pointer-coarse:opacity-100'

// Pops out of its own centre, as quickly as a row's buttons slide out.
const POP = 'transition-[opacity,scale] duration-100 ease-[cubic-bezier(0.2,0,0.15,1)] motion-reduce:transition-none'

/**
 * A gadget or a file in the Library's grid, as a square tile: its own picture, filling it, or else
 * the glyph of what it is over its name. Pointed at, More and its star pop out in its top corner; a
 * starred one keeps its star out. Pressed, it gives a little. Right-click it for the same menu as
 * More.
 */
export const LibraryTile = ({ title, icon, thumbnail, time, starred, onStarredChange, actions, href, onSelect }: LibraryItemProps) => (
  <ContextMenu menu={libraryMenu(actions)} aria-label={`More for ${title}`} className="block">
    <div className="group relative aspect-square overflow-hidden rounded-2xl bg-kumo-contrast/3 ring-1 ring-kumo-contrast/6 transition-[scale] duration-150 ease-out has-[.tile:active]:scale-[0.97] has-focus-visible:ring-kumo-contrast/20 motion-reduce:transition-none">
      <LinkButton
        href={href}
        onClick={onSelect}
        title={time ? `${title} · ${time}` : title}
        className="tile absolute inset-0 flex flex-col justify-between p-3 text-left outline-none"
      >
        {thumbnail ? (
          <>
            <img src={thumbnail} alt="" className="absolute inset-0 size-full object-cover transition-[scale] duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transition-none" />
            <span className="sr-only">{title}</span>
          </>
        ) : (
          <>
            <span className="flex text-kumo-default [&>svg]:size-5">{icon}</span>
            <span className="line-clamp-2 text-sm/[1.125rem] font-medium break-words text-kumo-default">{title}</span>
          </>
        )}
      </LinkButton>
      <div className="absolute end-2 top-2 flex gap-1">
        {actions.length > 0 && (
          <span className={cn('flex', POP, HIDDEN)}>
            <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${title}`} triggerVariant="ghost" triggerClassName={BUTTON} align="end">
              {libraryMenu(actions)}
            </DropdownMenu>
          </span>
        )}
        {starred !== undefined && onStarredChange && (
          <span className={cn('flex', POP, starred ? REVEALED : HIDDEN)}>
            <Button
              variant="ghost"
              icon={<StarIcon weight={starred ? 'fill' : 'bold'} />}
              aria-label={`Star ${title}`}
              aria-pressed={starred}
              onClick={() => onStarredChange(!starred)}
              className={BUTTON}
            />
          </span>
        )}
      </div>
    </div>
  </ContextMenu>
)
