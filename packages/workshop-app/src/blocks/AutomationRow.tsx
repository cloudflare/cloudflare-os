import { ClockIcon, LightningIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton } from '@/components/LinkButton'
import { Markdown } from '@/components/Markdown'
import { Switch } from '@/components/Switch'
import { ResourceLink, type ResourceLinkProps } from './ResourceLink'
import { usePending, type ActionResult } from './usePending'

export type AutomationRowProps = {
  /** A scheduled task (a clock), or something an event a service delivers sets off (a bolt). */
  kind: 'schedule' | 'event'
  title: string
  /** When it runs, in words: "Every weekday at 9:00 AM". Absent where that is not known. */
  when?: string
  /** How it stands, after `when`: "next tomorrow at 9:00 AM", or why it stopped, as a warning. */
  standing?: { words: string; tone: 'quiet' | 'warning' }
  /** What it does each time, as it was set up to, in Markdown. */
  description?: string
  /** What an event comes from, such as a board or an inbox. */
  resource?: ResourceLinkProps
  /** The gadget whose code it runs, which opens it. */
  gadget?: { title: string; href?: string; onOpen: () => void }
  enabled: boolean
  /** Absent for whoever may not change it, who sees whether it is on. */
  onEnabledChange?: (enabled: boolean) => ActionResult
  /** Why the last change to it was refused. */
  problem?: string
}

/**
 * One automation in a list of them: a clock or a bolt, its name, when it runs and when next (or
 * Paused, or why it stopped), what it does, what it watches and the gadget it runs, which opens
 * it. Its switch is at the end, held while the workspace answers.
 */
export const AutomationRow = ({ kind, title, when, standing, description, resource, gadget, enabled, onEnabledChange, problem }: AutomationRowProps) => {
  const [pending, run] = usePending()
  const Glyph = kind === 'schedule' ? ClockIcon : LightningIcon
  // Paused says so in place of when it runs next, which it no longer does.
  const state = enabled ? standing : { words: 'Paused', tone: 'quiet' as const }

  return (
    <div className="flex items-start gap-3 rounded-2xl p-3 text-base">
      <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-fill', enabled ? 'text-kumo-default' : 'text-kumo-inactive')}>
        <Glyph aria-hidden="true" className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
        <span className={cn('truncate font-medium', enabled ? 'text-kumo-default' : 'text-kumo-subtle')}>{title}</span>
        {(when || state) && (
          <span className="text-kumo-subtle">
            {when}
            {when && state && ' · '}
            {state && <span className={cn(state.tone === 'warning' && 'text-kumo-warning')}>{state.words}</span>}
          </span>
        )}
        {description && <div className="line-clamp-2 text-sm text-kumo-subtle"><Markdown>{description}</Markdown></div>}
        {(resource || gadget) && (
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {resource && <ResourceLink {...resource} />}
            {gadget && (
              <LinkButton href={gadget.href} onClick={gadget.onOpen} className="min-w-0 truncate text-sm text-kumo-default underline underline-offset-2">
                Runs {gadget.title}
              </LinkButton>
            )}
          </span>
        )}
        {problem && <span role="alert" className="mt-1 text-sm text-kumo-danger">{problem}</span>}
      </div>
      {/* On a line with the title, as a setting's switch is. */}
      {onEnabledChange && (
        <Switch
          aria-label={title}
          checked={enabled}
          busy={pending}
          onCheckedChange={(checked) => run(() => onEnabledChange(checked))}
          className="mt-0.5"
        />
      )}
      {!onEnabledChange && <span className="shrink-0 text-kumo-subtle">{enabled ? 'On' : 'Off'}</span>}
    </div>
  )
}
