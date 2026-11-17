import { FormatIcon, type FormatIconName } from '@/components/FormatIcon'
import { LinkButton } from '@/components/LinkButton'
import { Tooltip } from '@/components/Tooltip'
import { TemplateByline, type TemplateCreator } from './TemplateByline'

export type TemplateListingProps = {
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
  /** Its page, so that it can be opened in another tab. */
  href?: string
  onSelect: () => void
}

// A picture says nothing until its tooltip does, so it is not kept waiting.
const TOOLTIP_DELAY = 150

/**
 * One template, laid out along a line the way a store lists an app: what it makes on a tile, as
 * an app's icon is, then its title over what it is for, with who it is by, as their picture, and
 * the services it needs connected beside it at the card's end (`TemplateByline`). All of the card
 * opens its page, which is where it is used from.
 */
export const TemplateListing = ({ title, description, kind, icon, creator, connections, href, onSelect }: TemplateListingProps) => (
  // Its surface under it, which pointing at it darkens, as a `TemplateCard`'s: a shade in place of
  // the surface would be no darker than it.
  <div className="flex rounded-3xl bg-kumo-tint">
  <LinkButton
    href={href}
    onClick={onSelect}
    className="flex flex-1 cursor-pointer items-start gap-3 rounded-3xl p-4 text-left text-base hover:bg-kumo-contrast/5 focus-visible:bg-kumo-contrast/5"
  >
    {/* What it makes, which it says when pointed at, and to a reader first. */}
    <Tooltip delay={TOOLTIP_DELAY} content={kind}>
      <span role="img" aria-label={kind} className="grid size-12 shrink-0 place-items-center rounded-[0.875rem] bg-kumo-base text-kumo-subtle ring-1 ring-kumo-line">
        <FormatIcon name={icon} className="size-6" />
      </span>
    </Tooltip>
    <span className="flex min-h-12 min-w-0 flex-1 flex-col gap-0.5 self-stretch leading-snug">
      <span className="line-clamp-1 font-medium wrap-anywhere text-kumo-default">{title}</span>
      {description && <span className="line-clamp-2 text-sm text-kumo-subtle">{description}</span>}
      {/* At the card's end, so that they line up along a line of cards that say more or less. */}
      <span className="mt-auto block pt-2">
        <TemplateByline creator={creator} connections={connections} />
      </span>
    </span>
  </LinkButton>
  </div>
)
