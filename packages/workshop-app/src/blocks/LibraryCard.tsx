import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { LinkButton } from '@/components/LinkButton'
import { CardAction } from './CardAction'
import { StarButton } from './StarButton'

export type LibraryCardProps = {
  title: string
  /** A line under the title: what it is, and whose when it is somebody else's. */
  detail?: string
  /** What it is drawn as, when its blueprint says; otherwise an app. */
  icon?: FormatIconName
  /** When it was, as the list it is in puts it. */
  time?: string
  starred: boolean
  onStarredChange: (starred: boolean) => void
  /** Its page, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

/**
 * One output on the Library page, as a card: what it is, and under it its title, on two lines at
 * most, then what it is in words and when it was, a line each. Pointed at, its star shows in its
 * corner; a starred one keeps its star.
 */
export const LibraryCard = ({ title, detail, icon, time, starred, onStarredChange, href, onSelect }: LibraryCardProps) => (
  <div className="group relative flex flex-col rounded-3xl bg-kumo-tint">
    <LinkButton
      href={href}
      onClick={onSelect}
      // The whole card opens the output, apart from the button over it.
      className="flex flex-1 flex-col justify-between gap-8 rounded-3xl p-4 text-left text-base group-hover:bg-kumo-contrast/5 group-has-focus-visible:bg-kumo-contrast/5"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-fill text-kumo-subtle">
        <FormatIcon name={icon} className="size-5" />
      </span>
      <span className="flex min-w-0 flex-col gap-1 leading-snug">
        <span className="line-clamp-2 font-medium wrap-anywhere text-kumo-default">{title}</span>
        <span className="flex flex-col text-sm text-kumo-subtle">
          {detail && <span className="truncate">{detail}</span>}
          {time && <span className="truncate">{time}</span>}
        </span>
      </span>
    </LinkButton>
    <span className="absolute top-2 right-2 flex">
      <CardAction shown={starred}>
        <StarButton title={title} starred={starred} onStarredChange={onStarredChange} />
      </CardAction>
    </span>
  </div>
)
