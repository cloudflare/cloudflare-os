import type { Ref } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { ContextMenu } from '@/components/ContextMenu'
import { LinkButton } from '@/components/LinkButton'
import { AttachmentTileFace } from './AttachmentTileFace'
import { CardAction } from './CardAction'
import { SHEET } from './FanCard'
import type { FileThumbnail } from './file-preview/useFileThumbnail'
import { LibraryGlyph, LibraryMore, libraryMenu, WaitingLabel, type LibraryItemProps } from './LibraryRow'
import { StarButton } from './StarButton'

export type LibraryCardProps = LibraryItemProps & {
  /**
   * A glimpse of it, where it has no picture of its own: a gadget's screen, a document's first
   * page. Shown in place of its icon, as a sheet standing in the card.
   */
  preview?: FileThumbnail | null
  /** Watched for coming near the screen, when its glimpse is fetched. */
  ref?: Ref<HTMLDivElement>
}

/**
 * A gadget or a file in the Library, as a card: what it is, and under it its title, on two lines at
 * most, then what it is in words and when it was, or what waits on the viewer, a line each. With a
 * picture of its own, that fills a well in the card in its icon's place; with a glimpse of it, the
 * glimpse stands in the well as a sheet of paper, lifted a little more when the card is pointed at. Pointed at,
 * More and its star show in its corner; a starred one keeps its star. Right-click it for the same
 * menu as More.
 */
export const LibraryCard = ({ title, detail, icon, thumbnail, preview, time, waiting, starred, onStarredChange, actions, href, onSelect, ref }: LibraryCardProps) => (
  <ContextMenu menu={libraryMenu(actions)} aria-label={`More for ${title}`} className="flex">
    <div ref={ref} className="group relative flex flex-1 flex-col rounded-3xl bg-kumo-tint">
      <LinkButton
        href={href}
        onClick={onSelect}
        // The whole card opens it, apart from the buttons over it.
        className={cn(
          'flex flex-1 flex-col justify-between rounded-3xl p-4 text-left text-base group-hover:bg-kumo-contrast/5 group-has-focus-visible:bg-kumo-contrast/5 group-has-data-popup-open:bg-kumo-contrast/5',
          thumbnail || preview ? 'gap-3' : 'gap-8',
        )}
      >
        {thumbnail ? (
          // Its own picture fills the well.
          <img src={thumbnail} alt="" className="-mx-1 -mt-1 h-28 w-[calc(100%+0.5rem)] shrink-0 rounded-2xl object-cover ring-1 ring-kumo-contrast/6" />
        ) : preview ? (
          // Its foot is the well's, so the sheet stands in it; More and the star sit over its top.
          <span aria-hidden="true" className="relative -mx-1 -mt-1 h-28 shrink-0 overflow-hidden rounded-2xl bg-kumo-contrast/4">
            <span className={cn(SHEET, 'appears absolute inset-x-4 top-4 -bottom-2 transition-[translate,box-shadow] duration-300 ease-out group-hover:-translate-y-1 motion-reduce:transition-none')}>
              <AttachmentTileFace name={title} kind="file" thumbnail={preview} />
            </span>
          </span>
        ) : (
          <LibraryGlyph icon={icon} />
        )}
        <span className="flex min-w-0 flex-col gap-1 leading-snug">
          <span className="line-clamp-2 font-medium wrap-anywhere text-kumo-default">{title}</span>
          <span className="flex flex-col text-sm text-kumo-subtle">
            {detail && <span className="truncate">{detail}</span>}
            {waiting ? <WaitingLabel count={waiting} /> : time && <span className="truncate">{time}</span>}
          </span>
        </span>
      </LinkButton>
      <span className="absolute top-2 right-2 flex">
        {actions.length > 0 && (
          <CardAction>
            <LibraryMore title={title} actions={actions} />
          </CardAction>
        )}
        {starred !== undefined && onStarredChange && (
          <CardAction shown={starred}>
            <StarButton title={title} starred={starred} onStarredChange={onStarredChange} />
          </CardAction>
        )}
      </span>
    </div>
  </ContextMenu>
)
