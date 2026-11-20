import type { ReactNode } from 'react'
import { LightningIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { LinkButton, Markdown, Switch } from '@gadgets/ui'
import { ResourceLink, type ResourceLinkProps } from './ResourceLink'
import { usePending, type ActionResult } from './usePending'

export type AutomationRowProps = {
  title: string
  /** What it does each time, as it was set up to, in Markdown. */
  description?: string
  /** What it watches or runs on, such as a board or an inbox. */
  resource?: ResourceLinkProps
  /** The gadget whose code it runs, which opens it. */
  gadget?: { title: string; href?: string; onOpen: () => void }
  /** The workspace it is in, under its icon, where it is listed among others': it opens the workspace. */
  workspace?: { title: string; icon: ReactNode; href?: string; onOpen: () => void }
  enabled: boolean
  /** Absent for whoever may not change it, who sees whether it is on. */
  onEnabledChange?: (enabled: boolean) => ActionResult
  /** Why the last change to it was refused. */
  problem?: string
}

/**
 * One automation in a list of them: its name (and Paused, while it is off), what it does, what it
 * watches and the gadget it runs, which opens it, and, among other workspaces', the workspace it
 * is in. Its switch is at the end, held while
 * the workspace answers.
 */
export const AutomationRow = ({ title, description, resource, gadget, workspace, enabled, onEnabledChange, problem }: AutomationRowProps) => {
  const [pending, run] = usePending()

  return (
    <div className="flex items-start gap-3 rounded-2xl p-3 text-base">
      <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl bg-kumo-fill', enabled ? 'text-kumo-default' : 'text-kumo-inactive')}>
        <LightningIcon aria-hidden="true" className="size-5" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
        <span className={cn('truncate font-medium', enabled ? 'text-kumo-default' : 'text-kumo-subtle')}>{title}</span>
        {!enabled && <span className="text-kumo-subtle">Paused</span>}
        {description && <div className="line-clamp-2 text-sm text-kumo-subtle"><Markdown>{description}</Markdown></div>}
        {(resource || gadget || workspace) && (
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {workspace && (
              <LinkButton href={workspace.href} onClick={workspace.onOpen} className="flex min-w-0 items-center gap-1.5 text-sm text-kumo-default hover:underline underline-offset-2 [&>svg]:shrink-0">
                {workspace.icon}
                <span className="truncate">{workspace.title}</span>
              </LinkButton>
            )}
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
