import { cn } from '@cloudflare/kumo/utils'

/**
 * That a gadget asks something of the user, where it is listed: how many, beside a dot in the
 * colour of something to look at, which its own pane asks when it is opened.
 */
export const WaitingBadge = ({ count, className }: { count: number; className?: string }) => (
  <span className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-full bg-kumo-warning-tint py-0.5 ps-2 pe-2.5 text-sm/5 font-medium text-kumo-default', className)}>
    <span aria-hidden="true" className="size-1.5 rounded-full bg-kumo-warning" />
    {count} waiting
  </span>
)
