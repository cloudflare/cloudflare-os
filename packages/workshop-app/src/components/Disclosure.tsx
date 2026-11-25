import type { AnimationEvent, ReactNode } from 'react'
import { Collapsible } from '@cloudflare/kumo/primitives/collapsible'
import { ArrowRight01Icon } from './icons'
import { cn } from '@cloudflare/kumo/utils'
import './Disclosure.css'

export type DisclosureProps = {
  /** The always-visible line; the whole of it is the button. */
  summary: ReactNode
  /** Rendered only while open. */
  children: ReactNode
  open: boolean
  onToggle: () => void
  /** Leave the chevron off the line, for one that should not draw the eye. It opens all the same. */
  hideCaret?: boolean
  /** For the line that opens it: its padding and size, where it is not to be a pill of its own. */
  triggerClassName?: string
  /** Nothing to open yet: the line is only a line. */
  disabled?: boolean
  className?: string
  /** An animation on it, or in it, ended: for one that waits for its own coming in. */
  onAnimationEnd?: (event: AnimationEvent<HTMLDivElement>) => void
}

/**
 * A quiet row that opens to show more beneath it. Controlled, so what is open can outlive the row
 * being unmounted (a virtual list does that to rows far off screen).
 */
export const Disclosure = ({ summary, children, open, onToggle, hideCaret, triggerClassName, disabled, className, onAnimationEnd }: DisclosureProps) => (
  <Collapsible.Root open={open} onOpenChange={onToggle} disabled={disabled} onAnimationEnd={onAnimationEnd} className={cn('flex min-w-0 flex-col text-base/5', className)}>
    <Collapsible.Trigger className={cn('group flex max-w-full cursor-pointer items-center gap-2 self-start rounded-full px-2 py-1 text-left text-kumo-subtle hover:text-kumo-default', triggerClassName)}>
      {summary}
      {!hideCaret && (
        <ArrowRight01Icon aria-hidden="true" weight="bold" className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none" />
      )}
    </Collapsible.Trigger>
    <Collapsible.Panel className="disclosure-panel">{children}</Collapsible.Panel>
  </Collapsible.Root>
)
