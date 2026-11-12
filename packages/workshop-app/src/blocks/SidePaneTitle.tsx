import type { ReactElement } from 'react'
import { XIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Button } from '@/components/Button'

export type SidePaneTitleProps = {
  title: string
  /** What kind of thing it is, before its name. */
  icon?: ReactElement
  /** Closes what it names. Without it, the bubble is only the name. */
  onClose?: () => void
}

/**
 * The name of what is shown in the side pane, as a bubble shaped like a button. Pointed at, it
 * grows out at its end to make room for a button that closes what it names. The button is also
 * there while focus is in the bubble, and always on a screen that cannot hover. Without
 * `onClose` it is only the name.
 */
export const SidePaneTitle = ({ title, icon, onClose }: SidePaneTitleProps) => (
  <span className={cn('group/title inline-flex h-9 min-w-0 items-center rounded-full bg-kumo-base text-base font-medium text-kumo-default ring-1 ring-kumo-line', icon ? 'ps-3' : 'ps-4', !onClose && 'pe-4')}>
    {icon && <span className="me-2 flex shrink-0 text-kumo-subtle [&>svg]:size-[1.125em]">{icon}</span>}
    <span className="truncate">{title}</span>
    {/* A grid column, so that it opens to the button's width without that being measured. At rest
        it is as wide as the bubble's own padding. */}
    {onClose && (
      <span className="grid shrink-0 grid-cols-[0fr] transition-[grid-template-columns] duration-200 ease-out group-focus-within/title:grid-cols-[1fr] group-hover/title:grid-cols-[1fr] motion-reduce:transition-none [@media(hover:none)]:grid-cols-[1fr]">
        <span className="flex min-w-4 overflow-x-clip pe-1">
          <Button
            variant="ghost"
            icon={XIcon}
            aria-label={`Close ${title}`}
            onClick={onClose}
            className="ms-1.5 size-7 opacity-0 transition-opacity duration-200 group-focus-within/title:opacity-100 group-hover/title:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
          />
        </span>
      </span>
    )}
  </span>
)
