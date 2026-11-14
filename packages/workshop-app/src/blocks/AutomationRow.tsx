import { useState } from 'react'
import { Switch } from '@cloudflare/kumo'
import { ArrowUpRightIcon, ClockIcon, DotsThreeIcon, LightningIcon, TrashIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { DropdownMenu } from '@/components/DropdownMenu'
import { LinkButton } from '@/components/LinkButton'

export type AutomationRowProps = {
  /** A scheduled task (a clock), or something a service's event sets off (a bolt). */
  kind: 'schedule' | 'event'
  title: string
  /** When it runs, in words: "Every weekday at 9:00 AM", or for an event, what it watches. */
  when?: string
  /** How it stands, after `when`: "next tomorrow at 9:00 AM", or why it stopped, as a warning. */
  standing?: { words: string; tone: 'quiet' | 'warning' }
  /** What it does each time, as it was set up to. */
  description?: string
  /** Where it reports: the chat it runs in, or the gadget it wakes. Opens it. */
  place?: { kind: 'chat' | 'gadget'; label: string; href?: string; onOpen: () => void }
  enabled: boolean
  /** Absent for whoever may not change it. Rejects with why, which is shown under it. */
  onEnabledChange?: (enabled: boolean) => Promise<void>
  /** Deletes it once asked; `false` if it was not tried, and a rejection says why (`ConfirmDialog`). */
  onDelete?: () => Promise<boolean>
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * One automation, as a settings row: a clock or a bolt, its name, when it runs and when next (or
 * Paused, or why it stopped), what it does, and where it reports, which opens it. Its switch is at
 * the end, held while the server answers, with More beside it for Delete, which asks first. What
 * the server refused is said under it.
 */
export const AutomationRow = ({ kind, title, when, standing, description, place, enabled, onEnabledChange, onDelete }: AutomationRowProps) => {
  const [pending, setPending] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [deleting, setDeleting] = useState(false)
  const Glyph = kind === 'schedule' ? ClockIcon : LightningIcon

  return (
    <div className={cn('group flex items-start gap-3 rounded-2xl py-3 pr-2 pl-3 text-base hover:bg-kumo-contrast/3 has-data-popup-open:bg-kumo-contrast/3', !enabled && 'text-kumo-subtle')}>
      <span
        aria-hidden="true"
        className={cn(
          'grid size-9 shrink-0 place-items-center rounded-full transition-colors duration-150 [&>svg]:size-[1.125rem]',
          enabled ? 'bg-kumo-contrast/7 text-kumo-default' : 'bg-kumo-contrast/4 text-kumo-subtle',
        )}
      >
        <Glyph weight={enabled ? 'regular' : 'light'} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 pt-px">
        <span className={cn('truncate font-medium', enabled ? 'text-kumo-default' : 'text-kumo-subtle')}>{title}</span>
        {(when || standing || !enabled) && (
          <span className="text-sm/5 text-kumo-subtle">
            {when}
            {!enabled ? (
              <>{when && ' · '}Paused</>
            ) : standing && (
              <>
                {when && ' · '}
                <span className={cn(standing.tone === 'warning' && 'text-kumo-warning')}>{standing.words}</span>
              </>
            )}
          </span>
        )}
        {description && <span className="line-clamp-2 text-sm/5 text-kumo-subtle">{description}</span>}
        {place && (
          <LinkButton
            href={place.href}
            onClick={place.onOpen}
            className="mt-1 flex w-fit max-w-full items-center gap-1 rounded-md text-sm/5 font-medium text-kumo-default underline-offset-2 hover:underline"
          >
            <span className="truncate">{place.label}</span>
            <ArrowUpRightIcon aria-hidden="true" className="size-3.5 shrink-0 text-kumo-subtle" />
          </LinkButton>
        )}
        {problem && <span role="alert" className="mt-1 text-sm/5 text-kumo-danger">{problem}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-0.5 pt-1.5">
        {onEnabledChange && (
          <Switch
            size="sm"
            aria-label={`${title}: on`}
            checked={enabled}
            // Not `disabled`, which would take focus from a keyboard user mid-change.
            aria-disabled={pending || undefined}
            transitioning={pending}
            onCheckedChange={(checked) => {
              if (pending) return
              setPending(true)
              setProblem(undefined)
              onEnabledChange(checked)
                .catch((error: unknown) => setProblem(`Couldn’t turn it ${checked ? 'on' : 'off'}. ${messageOf(error)}`))
                .finally(() => setPending(false))
            }}
          />
        )}
        {(onDelete || place) && (
          <DropdownMenu icon={DotsThreeIcon} aria-label={`More for ${title}`} triggerVariant="ghost" triggerClassName="-my-1.5 text-kumo-subtle" align="end">
            {place && <DropdownMenu.Item icon={ArrowUpRightIcon} onSelect={place.onOpen}>{place.kind === 'chat' ? 'Open chat' : 'Open gadget'}</DropdownMenu.Item>}
            {onDelete && <DropdownMenu.Item icon={TrashIcon} danger onSelect={() => setDeleting(true)}>Delete…</DropdownMenu.Item>}
          </DropdownMenu>
        )}
      </span>
      {onDelete && (
        <ConfirmDialog
          open={deleting}
          onOpenChange={setDeleting}
          destructive
          title={`Delete ${title}?`}
          description={kind === 'schedule'
            ? 'It stops for good. To stop it for now, turn it off instead.'
            : 'It stops for good, and what it watches no longer wakes anything. To stop it for now, turn it off instead.'}
          confirm="Delete"
          onConfirm={onDelete}
        />
      )}
    </div>
  )
}
