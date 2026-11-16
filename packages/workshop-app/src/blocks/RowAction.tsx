import type { ReactNode } from 'react'
import { cn } from '@cloudflare/kumo/utils'

// A button and the gap before it.
const ROOM = '[--action-room:calc(var(--control-size)+0.25rem)]'

/**
 * One of a row's buttons at its end, which slides out from under the edge, pushing what is before
 * it in, while the row (its `group`) is pointed at or has focus, or its menu is open. Always out to
 * a finger, which cannot point, and while `shown`.
 */
export const RowAction = ({ shown, children }: { shown?: boolean; children: ReactNode }) => (
  <span
    className={cn(
      // The sidebar underlay's glide (`useWorkspaceUnderlay`), so pointing at a row answers as quickly.
      ROOM,
      'flex shrink-0 justify-end transition-[width,opacity] duration-75 ease-[cubic-bezier(0.2,0,0.15,1)] motion-reduce:transition-none',
      shown
        ? 'w-(--action-room) opacity-100'
        : 'pointer-events-none w-0 opacity-0 group-has-focus-visible:pointer-events-auto group-has-focus-visible:w-(--action-room) group-has-focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:w-(--action-room) group-hover:opacity-100 group-has-data-popup-open:pointer-events-auto group-has-data-popup-open:w-(--action-room) group-has-data-popup-open:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:w-(--action-room) pointer-coarse:opacity-100',
    )}
  >
    {children}
  </span>
)
