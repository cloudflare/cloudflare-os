import type { ReactNode } from 'react'
import { ScrollArea as BaseScrollArea } from '@cloudflare/kumo/primitives/scroll-area'
import { cn } from '@cloudflare/kumo/utils'

export type ScrollAreaProps = {
  /** What it is called, for a reader, where what is in it does not say. */
  'aria-label'?: string
  /** Its shape and colour, and how tall it may get (`max-h-*`): what is in it scrolls from there on. */
  className?: string
  children: ReactNode
}

/**
 * What may be too long for where it is, scrolled in a box of its own. Its scrollbar is drawn over
 * the end of what is in it rather than beside it, so that is as wide, and as far from both sides,
 * as it would be with none: the scrollbar is there for as long as there is something to scroll to,
 * and not otherwise. It is drawn as `.scrollbar-shown` draws one, which takes room instead, for a
 * list whose rows have nothing at their end for it to be over.
 */
export const ScrollArea = ({ 'aria-label': label, className, children }: ScrollAreaProps) => (
  <BaseScrollArea.Root aria-label={label} className={cn('relative overflow-hidden', className)}>
    {/* As tall as the box may get, which is what is asked of the box. At its ends the page scrolls on. */}
    <BaseScrollArea.Viewport className="max-h-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:ring-inset">
      {children}
    </BaseScrollArea.Viewport>
    {/* As wide as a surface's padding, with its thumb in the middle, short of the surface's rounded corners. */}
    <BaseScrollArea.Scrollbar className="flex w-4 justify-center py-3">
      <BaseScrollArea.Thumb className="w-1.5 rounded-full bg-kumo-contrast/20 hover:bg-kumo-contrast/40 active:bg-kumo-contrast/40" />
    </BaseScrollArea.Scrollbar>
  </BaseScrollArea.Root>
)
