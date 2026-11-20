import { LightningIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'

/** What an automation is drawn as: a bolt, faint while it is off. */
export const AutomationGlyph = ({ enabled }: { enabled: boolean }) => (
  <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-fill', enabled ? 'text-kumo-default' : 'text-kumo-inactive')}>
    <LightningIcon aria-hidden="true" className="size-5" />
  </span>
)
