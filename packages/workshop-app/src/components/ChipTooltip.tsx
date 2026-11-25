import type { ReactElement, ReactNode } from 'react'
import { Tooltip } from '@cloudflare/kumo/primitives/tooltip'
import { cn } from '@cloudflare/kumo/utils'

/** What there is to say of what a chip names, to whoever points at it. */
export type ChipAbout = {
  /** What it is drawn with on its chip. */
  icon?: ReactNode
  title: string
  /** What it is for, in a sentence or two. */
  description?: string
  /** What it is and what tells it from another of its name, a word or two each: "Skill", "Writing tools". */
  facts?: readonly string[]
  /** Its chip cut its name short, so the whole name is worth saying by itself. */
  cut?: boolean
  /** Where it is on the web: the card is then a link there, which opens in a new tab. */
  href?: string
}

/**
 * What a chip's card says, or the way to find out, asked as the card is about to show: for what
 * is known only by whoever has the chip, and may not be known yet when the chip is drawn.
 * Nothing, where there is nothing to say of it beyond its name, which the chip says already:
 * then there is no card.
 */
export type ChipAboutSource = ChipAbout | (() => ChipAbout | undefined)

/**
 * How long a chip is pointed at before it says anything, in milliseconds: a pointer passing over
 * it on its way through the words says nothing.
 */
export const CHIP_TOOLTIP_DELAY = 350

// A small card rather than a line of words, on the surface a menu is on.
const POPUP =
  'origin-[var(--transform-origin)] rounded-[14px] bg-kumo-base px-3 py-2.5 text-kumo-default ring-1 ring-kumo-contrast/6 ' +
  'shadow-[0_8px_24px_rgb(0_0_0/0.08)] outline-none transition-[opacity,scale] duration-150 ' +
  'data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 motion-reduce:transition-none'

// Whether there is anything to say of it that its chip does not.
const says = ({ description, facts = [], cut }: ChipAbout) => !!description || facts.length > 0 || !!cut

/**
 * The card itself, for inside a tooltip's portal: its name by what it is drawn with, as on the
 * chip, in full; what it is for; and, quieter, what it is. Drawn only while the tooltip is open,
 * so what it says is asked for then, and nothing where that is nothing. Where what it names is on
 * the web, the card is a link there, which can be gone to with the pointer: it says when the
 * pointer comes onto it and leaves it (`onPointer`), for whoever keeps it open meanwhile.
 */
export const ChipTooltipCard = ({ about: source, anchor, onPointer }: { about: ChipAboutSource; anchor?: Element; onPointer?: (over: boolean) => void }) => {
  const about = typeof source === 'function' ? source() : source
  if (!about || !says(about)) return null
  const { icon, title, description, facts = [], href } = about
  const Body = href ? 'a' : 'div'
  return (
    <Tooltip.Positioner anchor={anchor} side="top" sideOffset={8} collisionPadding={12} className="z-50">
      <Tooltip.Popup
        role="tooltip"
        onPointerEnter={href ? () => onPointer?.(true) : undefined}
        onPointerLeave={href ? () => onPointer?.(false) : undefined}
        className={cn(POPUP, !href && 'pointer-events-none')}
      >
        <Body
          {...(href ? { href, target: '_blank', rel: 'noreferrer noopener' } : {})}
          className={cn('group flex w-fit max-w-60 flex-col gap-1.5 text-start', href && 'cursor-pointer no-underline outline-none')}
        >
          <div className="flex items-start gap-1.5 text-sm font-medium [&>svg]:mt-[3px] [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-kumo-subtle">
            {icon}
            <span className="line-clamp-2 min-w-0 wrap-anywhere">{title}</span>
          </div>
          {description && <p className={cn('line-clamp-3 text-[0.8125rem]/[1.125rem] text-kumo-subtle', href && 'wrap-anywhere group-hover:text-kumo-default')}>{description}</p>}
          {facts.length > 0 && (
            <p className={cn('truncate text-xs text-kumo-subtle', description && 'mt-1 border-t border-kumo-contrast/8 pt-2')}>{facts.join(' · ')}</p>
          )}
        </Body>
      </Tooltip.Popup>
    </Tooltip.Positioner>
  )
}

/**
 * A card of what a chip names, shown over the chip while it is pointed at, or, where the chip is
 * a link, has the focus. One that is a link (`linked`) stays while the pointer goes onto it.
 */
export const ChipTooltip = ({ about, linked, children }: { about: ChipAboutSource; linked?: boolean; children: ReactElement }) => (
  <Tooltip.Root disableHoverablePopup={!linked}>
    <Tooltip.Trigger render={children} delay={CHIP_TOOLTIP_DELAY} />
    <Tooltip.Portal>
      <ChipTooltipCard about={about} />
    </Tooltip.Portal>
  </Tooltip.Root>
)
