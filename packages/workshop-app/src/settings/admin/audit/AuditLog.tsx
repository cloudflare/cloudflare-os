import { useEffect, useState } from 'react'
import { CaretLeftIcon, CaretRightIcon, FunnelSimpleIcon, XIcon } from '@phosphor-icons/react'
import { cn } from '@cloudflare/kumo/utils'
import type { AdminAuditKind, AdminAuditPage } from '@gadgets/workshop-shared/api'
import { SettingsCard } from '@/blocks/SettingsGroup'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { OptionPicker } from '@/components/OptionPicker'
import { messageOf } from '../../useAttempt'
import type { AdminCapability } from '../AdminContext'
import { AUDIT_KINDS, AUDIT_METHOD_GROUPS, filterKey, isFiltered, targetUserOf, type AuditFilter } from './auditFilter'
import { AuditRecordRow } from './AuditRecordRow'
import { KIND_NAMES } from './auditText'

/** How many records a page of the log has. */
export const AUDIT_PAGE_SIZE = 50

// The dot that says a list's filter is on, as `ListToolbar`'s does.
const NARROWED = "after:absolute after:top-0 after:right-0 after:size-2.5 after:rounded-full after:bg-kumo-brand after:ring-2 after:ring-kumo-base after:content-['']"

const ANY_KIND = 'any'

const METHOD_OPTIONS = AUDIT_METHOD_GROUPS.flatMap(({ methods }) => methods.map((method) => ({ id: method, label: method })))

// The answer to one load, for the request it answered.
type Answer = { request: string } & ({ page: AdminAuditPage } | { failed: string })

type FilterMenuProps = {
  filter: AuditFilter
  admins: string[]
  targets: string[]
  onFilterChange: (filter: AuditFilter) => void
}

// Ids for people, in a picker that has none chosen: theirs, with the one narrowed to among them.
const peopleOptions = (people: string[], chosen: string | undefined) =>
  [...new Set([...(chosen ? [chosen] : []), ...people])].map((person) => ({ id: person, label: person }))

/**
 * What the log is narrowed to, as a menu, as a list's filters are (`ListToolbar`): the kind, chosen
 * in place, then the admin, the action and the user reached, each a menu of its own with a field
 * to find one by. Choosing the one that is chosen again leaves that alone. Its admins are those
 * most active this week and its users those reached on the page shown, as the server lists
 * neither; any other is narrowed to from a record's details.
 */
const FilterMenu = ({ filter, admins, targets, onFilterChange }: FilterMenuProps) => {
  const on = Object.values(filter).filter((value) => value !== undefined).length
  const pick = (key: 'admin' | 'method' | 'owner') => (id: string) => onFilterChange({ ...filter, [key]: filter[key] === id ? undefined : id })
  return (
    <DropdownMenu icon={FunnelSimpleIcon} aria-label={on > 0 ? `Filter (${on} on)` : 'Filter'} triggerClassName={cn(on > 0 && NARROWED)} align="end" inPlace>
      <DropdownMenu.Label>Show only</DropdownMenu.Label>
      <DropdownMenu.RadioGroup
        aria-label="Kind"
        value={filter.kind ?? ANY_KIND}
        onValueChange={(kind) => onFilterChange({ ...filter, kind: kind === ANY_KIND ? undefined : (kind as AdminAuditKind) })}
      >
        <DropdownMenu.RadioItem value={ANY_KIND}>Every kind</DropdownMenu.RadioItem>
        {AUDIT_KINDS.map((kind) => <DropdownMenu.RadioItem key={kind} value={kind}>{KIND_NAMES[kind]}</DropdownMenu.RadioItem>)}
      </DropdownMenu.RadioGroup>
      <DropdownMenu.Separator />
      <DropdownMenu.Submenu picker label="Admin" detail={filter.admin ? 1 : undefined}>
        <OptionPicker single aria-label="Admin" options={peopleOptions(admins, filter.admin)} value={filter.admin ?? ''} onValueChange={pick('admin')} />
      </DropdownMenu.Submenu>
      <DropdownMenu.Submenu picker label="Action" detail={filter.method ? 1 : undefined}>
        <OptionPicker single aria-label="Action" options={METHOD_OPTIONS} value={filter.method ?? ''} onValueChange={pick('method')} />
      </DropdownMenu.Submenu>
      <DropdownMenu.Submenu picker label="User reached" detail={filter.owner ? 1 : undefined}>
        <OptionPicker single aria-label="User reached" options={peopleOptions(targets, filter.owner)} value={filter.owner ?? ''} onValueChange={pick('owner')} />
      </DropdownMenu.Submenu>
      <DropdownMenu.Separator />
      {/* Always there, so that the menu keeps its size as filters are set. */}
      <DropdownMenu.Item disabled={on === 0} onSelect={() => onFilterChange({})}>
        <span className={on === 0 ? 'text-kumo-inactive' : undefined}>Clear all</span>
      </DropdownMenu.Item>
    </DropdownMenu>
  )
}

export type AuditLogProps = {
  admin: AdminCapability
  filter: AuditFilter
  onFilterChange: (filter: AuditFilter) => void
  /** Admins to offer to narrow the log to. */
  admins: string[]
  /** Goes up to load the page shown again (Refresh), staying on it. */
  reloads: number
  /**
   * Goes up to load the newest page: after a change to the settings, whose own record is there,
   * and whose retention may have taken away the pages turned to.
   */
  restarts: number
}

/**
 * The audit log, narrowed as `filter` says, a page at a time, the newest first. Older pages are
 * reached by each page's cursor, and newer ones by going back through the cursors used, so the
 * pages stay put while records arrive. What is narrowed to is said across the top, each with the
 * way to take it away. The page shown stays, fainter, until the one that replaces it is in.
 */
export const AuditLog = ({ admin, filter, onFilterChange, admins, reloads, restarts }: AuditLogProps) => {
  // The cursors of the pages turned to under this filter, the oldest page last. Forgotten once the
  // filter changes, or the log starts again, during that render.
  const under = JSON.stringify([filterKey(filter), restarts])
  const [turned, setTurned] = useState({ under, cursors: [] as string[] })
  if (turned.under !== under) setTurned({ under, cursors: [] })
  const cursors = turned.under === under ? turned.cursors : []
  const cursor = cursors.at(-1)
  const [retries, setRetries] = useState(0)
  const [answer, setAnswer] = useState<Answer>()
  // Everything a load depends on, so that the answer to an earlier one is told apart.
  const request = JSON.stringify([under, cursor ?? null, reloads, retries])

  const { admin: byAdmin, method, kind, workspace, owner } = filter
  useEffect(() => {
    let current = true
    admin.listAdminAudit({ admin: byAdmin, method, kind, workspace, owner, cursor, limit: AUDIT_PAGE_SIZE }).then(
      (page) => {
        if (current) setAnswer({ request, page })
      },
      (error) => {
        if (current) setAnswer({ request, failed: messageOf(error) })
      },
    )
    return () => {
      current = false
    }
  }, [admin, byAdmin, method, kind, workspace, owner, cursor, request])

  const page = answer && 'page' in answer ? answer.page : undefined
  const busy = answer?.request !== request
  const failed = answer && 'failed' in answer && !busy ? answer.failed : undefined
  const pageNumber = cursors.length + 1
  const targets = [...new Set(page?.records.flatMap((record) => targetUserOf(record) ?? []))]
  const workspaceTitle = page?.records.find((record) => record.kind === 'workspace' && record.workspaceId === workspace)
  const workspaceName = workspaceTitle?.kind === 'workspace' && workspaceTitle.workspaceTitle ? workspaceTitle.workspaceTitle : workspace
  const turnTo = (next: string[]) => {
    if (!busy) setTurned({ under, cursors: next })
  }

  // Each filter that is on, said with the way to take it away.
  const chips = [
    filter.kind && { key: 'kind', label: KIND_NAMES[filter.kind] },
    filter.admin && { key: 'admin', label: `By ${filter.admin}` },
    filter.method && { key: 'method', label: filter.method },
    filter.owner && { key: 'owner', label: `Reached ${filter.owner}` },
    filter.workspace && { key: 'workspace', label: `In ${workspaceName}` },
  ].filter((chip): chip is { key: keyof AuditFilter; label: string } => Boolean(chip))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 px-5">
        <FilterMenu filter={filter} admins={admins} targets={targets} onFilterChange={onFilterChange} />
        {chips.map(({ key, label }) => (
          <Button
            key={key}
            variant="secondary"
            icon={<XIcon weight="bold" />}
            aria-label={`Stop showing only: ${label}`}
            onClick={() => onFilterChange({ ...filter, [key]: undefined })}
            className="max-w-full min-w-0"
          >
            <span className={cn('truncate', key === 'method' && 'font-mono')}>{label}</span>
          </Button>
        ))}
      </div>
      {page === undefined && failed === undefined && <p role="status" className="appears-late px-5 text-base text-kumo-subtle">Loading the audit log…</p>}
      {failed !== undefined && (
        <p role="alert" className="flex flex-wrap items-center gap-3 px-5 text-base text-kumo-subtle">
          Couldn’t load the audit log: {failed}
          <Button variant="ghost" onClick={() => setRetries((count) => count + 1)}>Try again</Button>
        </p>
      )}
      {page !== undefined && failed === undefined && (
        <>
          <div aria-busy={busy || undefined} className={cn('transition-opacity motion-reduce:transition-none', busy && 'opacity-60')}>
            <SettingsCard>
              {page.records.length === 0
                ? (
                    <p className="py-4 text-kumo-subtle">
                      {pageNumber > 1 ? 'No older admin activity.' : isFiltered(filter) ? 'No admin activity matches these filters.' : 'No admin activity is recorded yet.'}
                    </p>
                  )
                : (
                    <ul aria-label="Admin activity" className="flex flex-col">
                      {page.records.map((record, index) => (
                        <AuditRecordRow key={`${cursor ?? ''}:${index}:${record.at.getTime()}`} record={record} onFilterBy={(added) => onFilterChange({ ...filter, ...added })} />
                      ))}
                    </ul>
                  )}
            </SettingsCard>
          </div>
          {(pageNumber > 1 || page.nextCursor !== undefined) && (
            <nav aria-label="Audit log pages" className="flex items-center justify-between gap-3 px-5">
              <Button icon={CaretLeftIcon} disabled={pageNumber === 1} onClick={() => turnTo(cursors.slice(0, -1))}>Newer</Button>
              <span aria-live="polite" className="text-sm text-kumo-subtle">Page {pageNumber}</span>
              <Button disabled={page.nextCursor === undefined} onClick={() => page.nextCursor !== undefined && turnTo([...cursors, page.nextCursor])}>
                Older
                <CaretRightIcon aria-hidden="true" />
              </Button>
            </nav>
          )}
        </>
      )}
    </div>
  )
}
