import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'
import { CaretDoubleRightIcon } from '@phosphor-icons/react'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { HeaderBubble } from '@/components/HeaderBubble'

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
   * It floats over what is under it, for want of room beside: it has a surface of its own, an edge
   * and a faint shadow to lift it off, is inset in it, and goes when something else is clicked, as
   * a menu does. Otherwise it is beside the page, as quiet text with no surface, which stays until
   * its minimize button is pressed.
   */
  floating?: boolean
  /** It is open from the start, as it was left, so it is there at once instead of opening. */
  instant?: boolean
  /** What the card holds (`ContextSection`), each of which scrolls once it is taller than it should be. */
  children: ReactNode
}

/**
 * What a page has, as a button over its top corner that says what there is: an icon and a number
 * for each kind, quiet text that is pointed at, and pressed, as one. It morphs into a
 * card that lists each kind, over where the button was, with a small minimize button in the same
 * corner, level with the first section's title, that morphs it back (`DropdownMenu`, in place). The
 * card is beside the page, with no surface of its own, and all quiet text, which what can be opened
 * in it turns to the main colour as it is pointed at. It takes no room of its own: whoever lays
 * the page out makes room for it.
 */
export const ContextPanel = ({ stats, summary, open, onOpenChange, floating = false, instant = false, children }: ContextPanelProps) => (
  <HeaderBubble origin="end">
    <DropdownMenu
      // Going between beside and floating is not opening or closing, which would play the menu's animation for what is only the room the page has changing, such as when something opens beside the chat: it is another menu, which is there at once.
      key={floating ? 'floating' : 'beside'}
      triggerVariant="ghost"
      // More room after the numbers than before the icons, which the card opening over it is not moved by: it keeps to the same right edge.
      triggerClassName="gap-3 ps-2.5 pe-4 text-[0.8125rem] text-kumo-subtle not-data-disabled:hover:bg-transparent hover:text-kumo-default"
      label={stats.map(({ key, icon, count, tight }) => (
        <span key={key} className={cn('flex items-center gap-1 tabular-nums [&>svg]:size-3.5', tight && 'gap-0.5')}>
          {icon}
          {count}
        </span>
      ))}
      aria-label={`What this chat has: ${summary}`}
      align="end"
      inPlace
      open={open}
      onOpenChange={onOpenChange}
      persistent={!floating}
      fade={!floating}
      duration={instant ? 1 : undefined}
      surfaceClassName={floating ? undefined : 'bg-transparent ring-0'}
      raised={floating}
      popupClassName="w-[min(17rem,calc(100vw-1.5rem))] max-h-[min(var(--available-height),calc(100dvh-14rem))]"
    >
      {(close) => (
        // Beside the page it has no surface to be inset in, so it sits at the corner, in line with the buttons in the header: the first title level with them, and the minimize button's glyph as far in from the right as the rows' ends are. Floating, it is inset in its surface.
        <div data-floating={floating || undefined} className={cn('relative', floating && 'p-2.5')}>
          {/* Sections alone in what holds them, so that the first and last of them are the first and last of it. */}
          <div className="flex flex-col">{children}</div>
          {/* Floating, it is put away by going elsewhere, as a menu is. */}
          {!floating && (
            <Button
              variant="ghost"
              icon={<CaretDoubleRightIcon aria-hidden="true" weight="bold" className="size-3.5!" />}
              aria-label="Minimize"
              title="Minimize"
              onClick={close}
              className="absolute top-0 end-0.75 z-10 size-7 text-kumo-subtle not-data-disabled:hover:bg-transparent hover:text-kumo-default"
            />
          )}
        </div>
      )}
    </DropdownMenu>
  </HeaderBubble>
)
