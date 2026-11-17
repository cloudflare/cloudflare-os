import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { LinkButton } from '@/components/LinkButton'
import { Tooltip } from '@/components/Tooltip'
import { CardAction } from './CardAction'
import { StarButton } from './StarButton'
import { TemplateByline, type TemplateCreator } from './TemplateByline'
import { TemplatePreview } from './TemplatePreview'

export type TemplateCardProps = {
  title: string
  /** What it is for, of which a line or two is shown. */
  description?: string
  /** What making one gives, in a word: "Document". */
  kind: string
  /** What that is drawn as; otherwise an app. */
  icon?: FormatIconName
  /** Who it is by. */
  creator: TemplateCreator
  /** The services it has to be connected to before it can be used, by name. */
  connections?: string[]
  /** A picture of what it makes, where its publisher gave one. */
  previewUrl?: string
  starred: boolean
  onStarredChange: (starred: boolean) => void
  /** Its page, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

// A picture says nothing until its tooltip does, so it is not kept waiting.
const TOOLTIP_DELAY = 150

/**
 * One template that a store makes much of: a picture of what it makes (`TemplatePreview`), with
 * what kind that is in its corner, then its title over what it is for, and at its end who it is
 * by and the services it needs connected (`TemplateByline`). Pointed at, its star shows in its
 * corner; a starred one keeps its star.
 */
export const TemplateCard = ({ title, description, kind, icon, creator, connections, previewUrl, starred, onStarredChange, href, onSelect }: TemplateCardProps) => (
  <div className="group relative flex flex-col rounded-3xl bg-kumo-tint">
    <LinkButton
      href={href}
      onClick={onSelect}
      // The whole card opens the template, apart from the button over it.
      className="flex flex-1 cursor-pointer flex-col rounded-3xl p-1.5 text-left text-base group-hover:bg-kumo-contrast/5 group-has-focus-visible:bg-kumo-contrast/5"
    >
      <span className="relative block">
        {/* As round as the card is, less the room around it. */}
        <TemplatePreview icon={icon} src={previewUrl} className="rounded-[1.125rem]" />
        <Tooltip delay={TOOLTIP_DELAY} content={kind}>
          <span role="img" aria-label={kind} className="absolute bottom-2 left-2 grid size-7 place-items-center rounded-lg bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line">
            <FormatIcon name={icon} className="size-4" />
          </span>
        </Tooltip>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1 px-2.5 pt-3 pb-2.5 leading-snug">
        <span className="line-clamp-2 font-medium wrap-anywhere text-kumo-default">{title}</span>
        {description && <span className="line-clamp-2 text-sm text-kumo-subtle">{description}</span>}
        {/* At the card's end, so that they line up along a line of cards that say more or less. */}
        <span className="mt-auto block pt-2">
          <TemplateByline creator={creator} connections={connections} spread />
        </span>
      </span>
    </LinkButton>
    <span className="absolute top-3 right-3 flex">
      <CardAction shown={starred}>
        {/* On a surface of its own, as it is over a picture. */}
        <StarButton title={title} starred={starred} onStarredChange={onStarredChange} className="bg-kumo-base ring-1 ring-kumo-line not-data-disabled:hover:bg-kumo-tint" />
      </CardAction>
    </span>
  </div>
)
