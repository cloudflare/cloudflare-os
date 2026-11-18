import type { ReactNode } from 'react'
import { CaretRightIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { Disclosure } from '@/components/Disclosure'

export type ContextSectionProps = {
  /** What the rows are: "Outputs". */
  title: string
  open: boolean
  onToggle: () => void
  /** All of them (`ContextRow`). */
  children: ReactNode
}

/**
 * One kind of thing a chat has, in the card of what it has: the title, which folds the rows away
 * and brings them back.
 */
export const ContextSection = ({ title, open, onToggle, children }: ContextSectionProps) => (
  <Disclosure
    open={open}
    onToggle={onToggle}
    // Its own chevron, smaller than a disclosure's and nearer the title: in the heaviest line weight there is.
    hideCaret
    summary={(
      <span className="flex items-center gap-1 text-base font-medium">
        {title}
        <CaretRightIcon aria-hidden="true" weight="bold" className={cn('size-2.5 shrink-0 transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
      </span>
    )}
    // Set apart from the next by room alone, which is under its rows, so that titles with their rows folded away stay together; the last has none, as the card's own padding makes up.
    className={cn(open && 'pb-3', 'last:pb-0')}
  >
    {/* Scrolled on its own once it is taller than a few rows, which the last shown is cut off to say. */}
    <div className="flex max-h-44 flex-col overflow-y-auto overscroll-y-contain">{children}</div>
  </Disclosure>
)
