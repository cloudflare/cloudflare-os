import { ContextMenu } from '@/components/ContextMenu'
import { LinkButton } from '@/components/LinkButton'
import { CardAction } from './CardAction'
import { LibraryGlyph, LibraryMore, libraryMenu, WaitingLabel, type LibraryItemProps } from './LibraryRow'
import { StarButton } from './StarButton'

/**
 * A gadget or a file in the Library, as a card: what it is (or its own picture), and under it its
 * title, on two lines at most, then what it is in words and when it was, or what waits on the
 * viewer, a line each. Pointed at, More and its star show in its corner; a starred one keeps its
 * star. Right-click it for the same menu as More.
 */
export const LibraryCard = ({ title, detail, icon, thumbnail, time, waiting, starred, onStarredChange, actions, href, onSelect }: LibraryItemProps) => (
  <ContextMenu menu={libraryMenu(actions)} aria-label={`More for ${title}`} className="flex">
    <div className="group relative flex flex-1 flex-col rounded-3xl bg-kumo-tint">
      <LinkButton
        href={href}
        onClick={onSelect}
        // The whole card opens it, apart from the buttons over it.
        className="flex flex-1 flex-col justify-between gap-8 rounded-3xl p-4 text-left text-base group-hover:bg-kumo-contrast/5 group-has-focus-visible:bg-kumo-contrast/5 group-has-data-popup-open:bg-kumo-contrast/5"
      >
        <LibraryGlyph icon={icon} thumbnail={thumbnail} />
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
