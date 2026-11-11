import { Switch } from '@cloudflare/kumo'
import { LightningIcon } from '@phosphor-icons/react'
import { Card } from '@/components/Card'
import { Markdown } from '@/components/Markdown'
import { ResourceLink, type ResourceLinkProps } from './ResourceLink'
import { usePending, type ActionResult } from './usePending'

export type HookCardProps = {
  title: string
  description?: string
  resource?: ResourceLinkProps
  enabled: boolean
  /** Absent for a hook that was deleted, which can only be looked at. */
  onEnabledChange?: (enabled: boolean) => ActionResult
}

/** Something the agent set up to run by itself when an event arrives, with its on/off switch. */
export const HookCard = ({ title, description, resource, enabled, onEnabledChange }: HookCardProps) => {
  const [pending, run] = usePending()
  return (
    <Card className="flex-row items-start">
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-kumo-fill text-kumo-default">
        <LightningIcon aria-hidden="true" className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-medium text-kumo-default">Hook: {title}</span>
        {description && <div className="text-sm text-kumo-subtle"><Markdown>{description}</Markdown></div>}
        {resource && <ResourceLink {...resource} />}
      </div>
      {onEnabledChange ? (
        <Switch
          size="sm"
          variant="neutral"
          aria-label={`Hook: ${title}`}
          checked={enabled}
          // Not `disabled`, which would take focus from a keyboard user mid-change.
          aria-disabled={pending || undefined}
          transitioning={pending}
          onCheckedChange={(checked) => {
            if (!pending) run(() => onEnabledChange(checked))
          }}
        />
      ) : (
        <span className="shrink-0 text-sm text-kumo-inactive">Deleted</span>
      )}
    </Card>
  )
}
