import type { Icon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'

export type StatusPillTone = 'warning' | 'danger' | 'info'

// Writing in its colour over a little of the same colour, see-through rather than a banner's tint
// (`SiteBanner`), which is made for the page and is muddy on the grey of the card a row is on.
const TONES: Record<StatusPillTone, string> = {
  warning: 'bg-kumo-warning/15 text-kumo-warning',
  danger: 'bg-kumo-danger/12 text-kumo-danger',
  info: 'bg-kumo-info/12 text-kumo-info',
}

export type StatusPillProps = {
  words: string
  tone: StatusPillTone
  /** What a narrow screen shows in place of the words, which are still read out; and how many, beside it, where more than one. */
  icon?: Icon
  count?: number
  className?: string
}

/**
 * How something in a list stands, in a word or two, as a pill: in the colour of what waits on
 * someone (`warning`), went wrong (`danger`), or is there to look at (`info`). "Needs approval".
 * Given an icon, a narrow screen shows that instead, with the count where there is one.
 */
export const StatusPill = ({ words, tone, icon: PillIcon, count, className }: StatusPillProps) => (
  <span
    title={PillIcon ? words : undefined}
    className={cn('inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2.5 text-sm font-medium whitespace-nowrap', PillIcon && 'max-md:px-1.5', TONES[tone], className)}
  >
    {PillIcon && <PillIcon aria-hidden="true" weight="bold" className="size-3.5 md:hidden" />}
    {PillIcon && count !== undefined && <span aria-hidden="true" className="md:hidden">{count}</span>}
    <span className={cn(PillIcon && 'max-md:sr-only')}>{words}</span>
  </span>
)
