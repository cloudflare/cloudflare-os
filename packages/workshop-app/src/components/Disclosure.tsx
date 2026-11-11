import type { ReactNode } from 'react'
import { Collapsible } from '@cloudflare/kumo/primitives/collapsible'
import { CaretRightIcon } from '@phosphor-icons/react'
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
  className?: string
}

/**
 * A quiet row that opens to show more beneath it. Controlled, so what is open can outlive the row
 * being unmounted (a virtual list does that to rows far off screen).
 */
export const Disclosure = ({ summary, children, open, onToggle, hideCaret, className }: DisclosureProps) => (
  <Collapsible.Root open={open} onOpenChange={onToggle} className={cn('flex min-w-0 flex-col text-base/5', className)}>
    <Collapsible.Trigger className="group flex max-w-full cursor-pointer items-center gap-2 self-start rounded-full px-2 py-1 text-left text-kumo-subtle hover:text-kumo-default">
      {summary}
      {!hideCaret && (
        <CaretRightIcon aria-hidden="true" weight="bold" className="size-3 shrink-0 transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none" />
      )}
    </Collapsible.Trigger>
    <Collapsible.Panel className="disclosure-panel">{children}</Collapsible.Panel>
  </Collapsible.Root>
)
