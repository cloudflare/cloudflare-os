import { useId, useState, type ReactNode } from 'react'
import { Badge, Button, Table } from '@cloudflare/kumo'
import { CaretRight } from '@phosphor-icons/react'
import type {
  AdminAccessRecord,
  AdminAuditRecord,
  AdminSettingChange,
  AdminVia,
} from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { accessLevelName, refusalName } from './accessNames'
import type { AuditFilter } from './auditFilter'
import { AuditValue } from './AuditValue'
import { KindBadge } from './KindBadge'

/** How many columns an AuditLogRow fills, for the table's empty and detail rows. */
export const AUDIT_LOG_COLUMNS = 6

const VIA_NAMES: Record<AdminVia, string> = { api: 'API', cli: 'CLI' }

// The settings stored as lists of entries with ids, whose keyless change is a change of order.
const ORDERED_SETTING_NAMES = new Map([
  ['formats', 'formats'],
  ['addedModels', 'added models'],
])

// The settings that are an order themselves, by what they order.
const ORDER_SETTING_NAMES = new Map([
  ['providerOrder', 'providers'],
  ['modelOrder', 'models'],
])

const NUMBER = new Intl.NumberFormat('en')

const changeName = (change: AdminSettingChange) => {
  const order = ORDER_SETTING_NAMES.get(change.setting)
  const setting = order === undefined ? change.setting : `Order of ${order}`
  if (change.key !== undefined) return `${setting} · ${change.key}`
  if (order !== undefined) return setting
  const ordered = ORDERED_SETTING_NAMES.get(change.setting)
  return ordered === undefined ? change.setting : `Order of ${ordered}`
}

// Where an excerpt starts and how long the values it was cut from are, in words.
const excerptLabel = ({ offset, beforeLength, afterLength }: NonNullable<AdminSettingChange['excerpt']>) => {
  const length = (characters: number | undefined) => characters === undefined ? '—' : NUMBER.format(characters)
  return `Excerpt from character ${NUMBER.format(offset + 1)} · ` +
    `${length(beforeLength)} → ${length(afterLength)} characters`
}

const SettingChanges = ({ changes }: { changes: AdminSettingChange[] }) => (
  <ul className="space-y-4">
    {changes.map((change, index) => (
      <li key={index} className="text-sm">
        <p className="font-mono text-xs text-kumo-strong break-all">{changeName(change)}</p>
        <div className="mt-1 grid gap-3 md:grid-cols-2">
          <div className="min-w-0">
            <p className="text-xs text-kumo-subtle mb-0.5">Before</p>
            <AuditValue value={change.before} label={`${changeName(change)}, before`} />
          </div>
          <div className="min-w-0">
            <p className="text-xs text-kumo-subtle mb-0.5">After</p>
            <AuditValue value={change.after} label={`${changeName(change)}, after`} />
          </div>
        </div>
        {change.excerpt && (
          <p className="mt-1 text-xs text-kumo-subtle">{excerptLabel(change.excerpt)}</p>
        )}
      </li>
    ))}
  </ul>
)

// A user's name that filters the log by them, shown whole: one longer than its column wraps,
// since the action is the column cut.
const NameFilter = ({ name, label, onFilter }: { name: string; label: string; onFilter: () => void }) => (
  <Button
    variant="ghost"
    size="sm"
    className="-ml-2 h-auto w-auto max-w-full whitespace-normal break-all py-0.5 text-left text-sm"
    aria-label={label}
    onClick={onFilter}
  >
    {name}
  </Button>
)

const Detail = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="grid gap-x-4 gap-y-0.5 sm:grid-cols-[10rem_minmax(0,1fr)]">
    <dt className="text-xs text-kumo-subtle">{term}</dt>
    <dd className="min-w-0 text-sm text-kumo-default break-words">{children}</dd>
  </div>
)

const AccessDetails = ({ record, onFilterBy }: {
  record: AdminAccessRecord
  onFilterBy: (filter: AuditFilter) => void
}) => {
  const args = Object.entries(record.args)
  return (
    <dl className="space-y-2">
      <Detail term="Workspace">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 h-auto max-w-full text-sm"
          aria-label={`Show only calls into ${record.workspaceTitle || record.workspaceId}`}
          onClick={() => onFilterBy({ workspace: record.workspaceId })}
        >
          <span className="truncate">{record.workspaceTitle || 'Untitled'}</span>
        </Button>
        <span className="block font-mono text-xs text-kumo-subtle break-all">{record.workspaceId}</span>
      </Detail>
      <Detail term="Reason">{record.reason}</Detail>
      <Detail term="Access">
        {accessLevelName(record.access)}
        {record.refused && <> · refused: {refusalName(record.refused)}</>}
      </Detail>
      {args.length > 0 && (
        <Detail term="Arguments">
          <span className="font-mono text-xs">
            {args.map(([name, value]) => `${name}: ${String(value)}`).join(' · ')}
          </span>
        </Detail>
      )}
      <Detail term="Via">{VIA_NAMES[record.via]}</Detail>
    </dl>
  )
}

/**
 * One record of the Audit tab's log: a summary row (time, admin, action, kind, target user),
 * with a toggle that shows the rest in a row below it: how the call came, and a setting record's
 * changes or an access record's workspace, reason, level and arguments. An access record's target
 * user is its workspace's owner, the user the call reached. The admin's name and the target user,
 * and in an access record's details its workspace, filter the log by `onFilterBy`. Names are never
 * cut: an action too long for the space left is, whole in its tooltip. `shaded` stripes the summary
 * row as Kumo stripes a table's even rows: Kumo counts the details row below each one, hidden or
 * not, so every summary row is an odd row to it and would never be striped.
 */
export const AuditLogRow = ({ record, shaded, onFilterBy }: {
  record: AdminAuditRecord
  shaded: boolean
  /** Adds a filter to those set. */
  onFilterBy: (filter: AuditFilter) => void
}) => {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const time = formatFullTimestamp(record.at)
  return (
    <>
      <Table.Row className={shaded ? 'bg-kumo-elevated' : undefined}>
        <Table.Cell className="pr-0">
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={`${expanded ? 'Hide' : 'Show'} details of ${record.method} at ${time}`}
            onClick={() => setExpanded((open) => !open)}
          >
            <CaretRight
              aria-hidden="true"
              className={`transition-transform motion-reduce:transition-none${expanded ? ' rotate-90' : ''}`}
            />
          </Button>
        </Table.Cell>
        <Table.Cell className="truncate text-sm text-kumo-subtle">
          <time dateTime={record.at.toISOString()} title={record.at.toISOString()}>{time}</time>
        </Table.Cell>
        <Table.Cell>
          <NameFilter
            name={record.admin}
            label={`Show only ${record.admin}’s activity`}
            onFilter={() => onFilterBy({ admin: record.admin })}
          />
        </Table.Cell>
        <Table.Cell className="font-mono text-xs text-kumo-default">
          <span className="block truncate" title={record.method}>{record.method}</span>
        </Table.Cell>
        <Table.Cell>
          <span className="flex flex-wrap items-center gap-1.5">
            <KindBadge kind={record.kind} />
            {record.kind === 'workspace' && record.refused && (
              <span title={refusalName(record.refused)}><Badge variant="warning">Refused</Badge></span>
            )}
          </span>
        </Table.Cell>
        <Table.Cell>
          {record.kind === 'setting'
            ? (
              // A setting change reaches every user, not one: no user is its target.
              <span className="text-sm text-kumo-subtle" title="Deployment-wide">
                <span aria-hidden="true">—</span>
                <span className="sr-only">Deployment-wide</span>
              </span>
            )
            : record.workspaceOwner
              ? (
                <NameFilter
                  name={record.workspaceOwner}
                  label={`Show only calls into workspaces ${record.workspaceOwner} owns`}
                  onFilter={() => onFilterBy({ owner: record.workspaceOwner })}
                />
              )
              : <span className="text-sm text-kumo-subtle">Unknown</span>}
        </Table.Cell>
      </Table.Row>
      <Table.Row id={detailsId} hidden={!expanded}>
        <Table.Cell colSpan={AUDIT_LOG_COLUMNS} className="bg-kumo-recessed">
          {expanded && (record.kind === 'workspace'
            ? <AccessDetails record={record} onFilterBy={onFilterBy} />
            : (
              <div className="space-y-4">
                <dl><Detail term="Via">{VIA_NAMES[record.via]}</Detail></dl>
                <SettingChanges changes={record.changes} />
              </div>
            ))}
        </Table.Cell>
      </Table.Row>
    </>
  )
}
