import { ClockIcon, LightningIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'

/** What an automation is drawn as: a clock for a schedule, a bolt for what an event sets off, faint while it is paused. */
export const AutomationGlyph = ({ kind, enabled }: { kind: 'schedule' | 'event'; enabled: boolean }) => {
  const Glyph = kind === 'schedule' ? ClockIcon : LightningIcon
  return (
    <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-fill', enabled ? 'text-kumo-default' : 'text-kumo-inactive')}>
      <Glyph aria-hidden="true" className="size-5" />
    </span>
  )
}
