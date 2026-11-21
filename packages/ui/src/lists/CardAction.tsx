import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'

/** How a button over a row or a card of a list is drawn: quiet until it is pointed at itself. */
export const LIST_ACTION = 'text-kumo-subtle not-data-disabled:hover:bg-kumo-contrast/5 not-data-disabled:hover:text-kumo-default'

/**
 * One of a card's buttons in its corner, out of sight until the card (its `group`) is pointed at or
 * has focus, or its menu is open. Always there to a finger, which cannot point, and while `shown`.
 */
export const CardAction = ({ shown, children }: { shown?: boolean; children: ReactNode }) => (
  <span
    className={cn(
      'relative flex transition-opacity duration-75 motion-reduce:transition-none',
      !shown && 'opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-has-data-popup-open:opacity-100 pointer-coarse:opacity-100',
    )}
  >
    {children}
  </span>
)
