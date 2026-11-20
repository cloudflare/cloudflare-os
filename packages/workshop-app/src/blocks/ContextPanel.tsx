import type { ReactNode, Ref } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { Button, DropdownMenu, HeaderBubble } from '@gadgets/ui'

export type ContextStat = {
  key: string
  /** What kind of thing it is. */
  icon: ReactNode
  /** How many of them there are. */
  count: number
  /** Its glyph has room built in beside it, so its number is drawn a little nearer it. */
  tight?: boolean
}

export type ContextPanelProps = {
  /** How many there are of each kind, as an icon and a number each, which are the button. */
  stats: ContextStat[]
  /** What there is, in words, as the button's name: "3 outputs · 1 automation". */
  summary: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * There is no room beside the page for the card, so it floats over it, from the button, and goes
   * when something else is clicked, as a menu does. Otherwise the button only opens it, and the
   * page lays it out (`ContextSide`), which the button then gives way to until it is put away.
   */
  floating?: boolean
  /** The button beside the page, to bring focus back to when the card is put away. */
  triggerRef?: Ref<HTMLButtonElement>
  /** What the card holds (`ContextSection`), for the card that floats: each of which scrolls once it is taller than it should be. */
  children?: ReactNode
}

// More room after the numbers than before the icons, which a card opening over it is not moved by: it keeps to the same right edge.
const TRIGGER_CLASS = 'gap-3 ps-2.5 pe-4 text-[0.8125rem] text-kumo-subtle not-data-disabled:hover:bg-transparent hover:text-kumo-default'

// What is drawn in place of another comes in over it, rather than replacing it at once.
const COMES_IN = 'inline-flex transition-opacity duration-200 starting:opacity-0 motion-reduce:transition-none'

/**
 * What a page has, as a button over its top corner that says what there is: an icon and a number
 * for each kind, quiet text that is pointed at, and pressed, as one. Where the page has room for it,
 * it opens to a card that the page lays out beside its content, and the button fades away until
 * the card is put away. Where it has not, it morphs into a card over the page that lists each
 * kind, over where the button was (`DropdownMenu`, in place). It takes no room of its own: whoever
 * lays the page out makes room for the card.
 */
export const ContextPanel = ({ stats, summary, open, onOpenChange, floating = false, triggerRef, children }: ContextPanelProps) => {
  const label = stats.map(({ key, icon, count, tight }) => (
    <span key={key} className={cn('flex items-center gap-1 tabular-nums [&>svg]:size-3.5', tight && 'gap-0.5')}>
      {icon}
      {count}
    </span>
  ))
  const name = `What this chat has: ${summary}`

  return (
    <HeaderBubble origin="end">
      {floating ? (
        <span key="floating" className={cn(COMES_IN, 'pointer-events-auto')}>
          <DropdownMenu
            triggerVariant="ghost"
            triggerClassName={TRIGGER_CLASS}
            label={label}
            aria-label={name}
            align="end"
            inPlace
            open={open}
            onOpenChange={onOpenChange}
            raised
            popupClassName="w-[min(17rem,calc(100vw-1.5rem))] max-h-[min(var(--available-height),calc(100dvh-14rem))]"
          >
            {/* Inset in its surface, with the card's rows read as ordinary text on it (`ContextRow`). */}
            <div data-floating="" className="relative p-2.5">
              {/* Sections alone in what holds them, so that the first and last of them are the first and last of it. */}
              <div className="flex flex-col">{children}</div>
            </div>
          </DropdownMenu>
        </span>
      ) : (
        // Out of reach as well as out of sight while the card is open, which has its own way to be put away.
        <span key="beside" inert={open} className={cn(COMES_IN, open ? 'opacity-0' : 'pointer-events-auto')}>
          <Button ref={triggerRef} variant="ghost" aria-label={name} aria-expanded={open} onClick={() => onOpenChange(true)} className={TRIGGER_CLASS}>
            {label}
          </Button>
        </span>
      )}
    </HeaderBubble>
  )
}
