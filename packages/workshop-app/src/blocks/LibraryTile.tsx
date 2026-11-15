import type { Ref } from 'react'
import { DotsThreeIcon, StarIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'
import { ContextMenu } from '@/components/ContextMenu'
import { DropdownMenu } from '@/components/DropdownMenu'
import { LinkButton } from '@/components/LinkButton'
import { AttachmentTileFace } from './AttachmentTileFace'
import { libraryMenu, type LibraryItemProps } from './LibraryRow'

// Over a picture as much as over the tile's own surface, so on a disc of their own.
const BUTTON = 'size-7 rounded-full bg-kumo-base/85 text-kumo-default shadow-[0_1px_2px_rgb(0_0_0/0.08)] backdrop-blur-sm [&_svg]:size-3.5 not-data-disabled:hover:bg-kumo-base'

const REVEALED = 'pointer-events-auto opacity-100 scale-100'
const HIDDEN = 'pointer-events-none scale-75 opacity-0 group-hover:pointer-events-auto group-hover:scale-100 group-hover:opacity-100 group-has-focus-visible:pointer-events-auto group-has-focus-visible:scale-100 group-has-focus-visible:opacity-100 group-has-data-popup-open:pointer-events-auto group-has-data-popup-open:scale-100 group-has-data-popup-open:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:scale-100 pointer-coarse:opacity-100'

// Pops out of its own centre, as quickly as a row's buttons slide out.
const POP = 'transition-[opacity,scale] duration-100 ease-[cubic-bezier(0.2,0,0.15,1)] motion-reduce:transition-none'

/**
 * A gadget or a file in the Library's grid, as a square tile: its own picture, filling it; or its
 * name heading the tile over a glimpse of it (a gadget's screen, a document's first page), a sheet
 * standing up out of the tile's foot, faded in once it is drawn; or else the glyph of what it is
 * over its name. Pointed at, More and its star pop out in
 * its top corner; a starred one keeps its star out. Pressed, it gives a little. Right-click it for
 * the same menu as More. `ref` is its square, for whoever draws its glimpse once it is near the
 * screen.
 */
export const LibraryTile = ({ title, icon, thumbnail, preview, time, starred, onStarredChange, actions, href, onSelect, ref }: LibraryItemProps & { ref?: Ref<HTMLDivElement> }) => (
  <ContextMenu menu={libraryMenu(actions)} aria-label={`More for ${title}`} className="block">
    <div ref={ref} className="group relative aspect-square overflow-hidden rounded-2xl bg-kumo-contrast/5 ring-1 ring-kumo-contrast/6 transition-[scale] duration-150 ease-out has-[.tile:active]:scale-[0.97] has-focus-visible:ring-kumo-contrast/20 motion-reduce:transition-none">
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
        ) : preview ? (
          <>
            {/* Its name heads the tile, as a folder's tab says what is in it. */}
            {/* Its end fades out under More and the star while they are out, so they sit on the
                tile's own surface, where they always show, and the name reads to its last letter
                the rest of the time. */}
            <span className={cn(
              'relative flex min-w-0 items-center gap-1.5',
              starred ? 'pe-7 group-hover:pe-0' : '',
              'group-hover:mask-r-from-[calc(100%-4.5rem)] group-hover:mask-r-to-[calc(100%-3.5rem)] group-has-focus-visible:mask-r-from-[calc(100%-4.5rem)] group-has-focus-visible:mask-r-to-[calc(100%-3.5rem)] group-has-data-popup-open:mask-r-from-[calc(100%-4.5rem)] group-has-data-popup-open:mask-r-to-[calc(100%-3.5rem)]',
            )}>
              <span className="flex shrink-0 text-kumo-subtle [&>svg]:size-3.5">{icon}</span>
              <span className="min-w-0 truncate text-xs/4 font-medium text-kumo-default">{title}</span>
            </span>
            {/* The glimpse is a sheet standing in the tile, rising out of its foot, lifted a little
                more when pointed at. */}
            <span aria-hidden="true" className="appears absolute inset-x-3 top-10 -bottom-px overflow-hidden rounded-t-lg bg-kumo-base shadow-[0_1px_2px_rgb(0_0_0/0.1),0_8px_20px_-8px_rgb(0_0_0/0.22)] ring-1 ring-kumo-contrast/12 transition-[translate,box-shadow] duration-300 ease-out group-hover:-translate-y-1 group-hover:shadow-[0_2px_4px_rgb(0_0_0/0.08),0_12px_24px_-8px_rgb(0_0_0/0.18)] motion-reduce:transition-none">
              <AttachmentTileFace name={title} kind="file" thumbnail={preview} />
            </span>
          </>
        ) : (
          <>
            <span className="flex text-kumo-default [&>svg]:size-5">{icon}</span>
            <span className="line-clamp-2 text-sm/[1.125rem] font-medium break-words text-kumo-default">{title}</span>
          </>
        )}
      </LinkButton>
      <div className="pointer-events-none absolute end-2 top-2 flex gap-1">
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
