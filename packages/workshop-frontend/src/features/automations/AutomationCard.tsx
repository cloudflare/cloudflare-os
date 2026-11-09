import type { ReactNode } from 'react'
import { DropdownMenu, Switch, Tooltip } from '@cloudflare/kumo'
import { Clock, Lightning } from '@phosphor-icons/react'
import { MoreIcon, TrashIcon } from '../../components/icons/designIcons'
import { MENU_CONTENT, MENU_ITEM_DANGER, MENU_POSITIONER_STYLE } from '../../components/menuStyles'

/** Whether a hook is a scheduled task, from its connection's address (`scheduler://tasks`). */
export const isScheduleUrl = (resourceUrl: string | undefined) => resourceUrl?.startsWith('scheduler:') ?? false

/**
 * One automation: something that runs on a schedule or when an event happens, as a chat sets it up
 * ("Morning inbox summary", "Weekdays at 8:00. Summarize unread email…"). It is on as soon as the
 * person's own chat makes it, so the card reads as a receipt with a way to pause or delete it, not
 * a question. A paused one says so beside its name; a deleted one stays in the chat, muted, so the
 * history still reads.
 */
export function AutomationCard({ title, description, schedule, source, origin, enabled, deleted = false, busy = false, onToggle, onDelete, className = '' }: {
  title: string
  description?: string
  /** A scheduled task, rather than a hook on a connection's events. */
  schedule: boolean
  /** What it watches, for a hook: its connection's name. */
  source?: string
  /** Where it belongs, in a list of a whole workspace's: the chat or app it runs, as a link. */
  origin?: ReactNode
  enabled: boolean
  deleted?: boolean
  busy?: boolean
  onToggle?: (enabled: boolean) => void
  onDelete?: () => void
  className?: string
}) {
  const Icon = schedule ? Clock : Lightning
  const status = deleted ? 'Deleted' : enabled ? null : 'Paused'
  const detail = !schedule && source ? (description ? `${source} · ${description}` : source) : description
  return (
    <div className={`group/automation flex w-full max-w-[560px] items-start gap-3 rounded-2xl bg-kumo-base p-3 ring-1 ring-kumo-line transition-opacity duration-200 ${deleted ? 'opacity-60' : ''} ${className}`}>
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-full transition-colors duration-200 ${enabled && !deleted ? 'bg-kumo-tint text-kumo-default' : 'bg-kumo-recessed text-kumo-inactive'}`}
        aria-hidden="true"
      >
        <Icon size={17} />
      </span>
      <div className="flex min-h-9 min-w-0 flex-1 flex-col justify-center">
        <p className="flex min-w-0 items-center gap-2 text-[14px] font-medium leading-5 text-kumo-default">
          <span className="min-w-0 truncate">{title}</span>
          {status && <span className="shrink-0 text-[13px] font-normal text-kumo-subtle">{status}</span>}
        </p>
        {detail && <p className="line-clamp-2 text-[13px] leading-[18px] text-kumo-subtle">{detail}</p>}
        {origin && <p className="mt-0.5 truncate text-[12px] leading-4 text-kumo-inactive">{origin}</p>}
      </div>
      {!deleted && (onToggle || onDelete) && (
        <div className="flex h-9 shrink-0 items-center gap-1">
          {onToggle && (
            <Tooltip content={enabled ? 'Pause' : 'Turn on'} asChild>
              <span className="inline-flex items-center px-1">
                <Switch
                  checked={enabled}
                  // Not `disabled`, which would take focus from a keyboard user mid-change.
                  aria-disabled={busy || undefined}
                  transitioning={busy}
                  className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                  size="sm"
                  aria-label={`${title}: ${enabled ? 'on' : 'paused'}`}
                  onCheckedChange={checked => { if (!busy) onToggle(checked) }}
                />
              </span>
            </Tooltip>
          )}
          {onDelete && (
            <DropdownMenu>
              <DropdownMenu.Trigger render={
                <button
                  type="button"
                  aria-label={`More for ${title}`}
                  className="flex size-7 cursor-pointer items-center justify-center rounded-full text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring data-[popup-open]:bg-kumo-tint"
                >
                  <MoreIcon size={16} />
                </button>
              } />
              <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE} align="end">
                <DropdownMenu.Item onClick={onDelete} className={`${MENU_ITEM_DANGER} text-kumo-danger`}>
                  <TrashIcon size={14} />
                  Delete
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  )
}
