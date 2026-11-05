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
import { ACCESS_LEVEL_NAMES, REFUSAL_NAMES } from './accessNames'
import { sensitivityOf, type AuditFilter } from './auditFilter'
import { AuditValue } from './AuditValue'
import { SensitivityBadge } from './SensitivityBadge'

/** How many columns an AuditLogRow fills, for the table's empty and detail rows. */
export const AUDIT_LOG_COLUMNS = 7

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

const summaryOf = (record: AdminAuditRecord) => {
  if (record.kind === 'workspace') return record.workspaceTitle || record.workspaceId
  if (record.changes.length === 0) return ''
  const more = record.changes.length - 1
  const first = changeName(record.changes[0])
  return more === 0 ? first : `${first} + ${NUMBER.format(more)} more`
}

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
      <Detail term="Owner">
        {record.workspaceOwner
          ? (
            <Button
              variant="ghost"
              size="sm"
              className="-ml-2 max-w-full text-sm"
              aria-label={`Show only calls into workspaces ${record.workspaceOwner} owns`}
              onClick={() => onFilterBy({ owner: record.workspaceOwner })}
            >
              <span className="truncate">{record.workspaceOwner}</span>
            </Button>
          )
          : <span className="text-kumo-subtle">Unknown</span>}
      </Detail>
      <Detail term="Reason">{record.reason}</Detail>
      <Detail term="Access">
        {ACCESS_LEVEL_NAMES[record.access]}
        {record.requested !== record.access && ` (${ACCESS_LEVEL_NAMES[record.requested]} requested)`}
        {record.refused && <> · refused: {REFUSAL_NAMES[record.refused]}</>}
      </Detail>
      {args.length > 0 && (
        <Detail term="Arguments">
          <span className="font-mono text-xs">
            {args.map(([name, value]) => `${name}: ${String(value)}`).join(' · ')}
          </span>
        </Detail>
      )}
    </dl>
  )
}

/**
 * One record of the Audit tab's log: a summary row, with a toggle that shows what the record holds
 * in full in a row below it. The admin's name, and in an access record's details its workspace and
 * the workspace's owner, filter the log by `onFilterBy`.
 */
export const AuditLogRow = ({ record, onFilterBy }: {
  record: AdminAuditRecord
  /** Adds a filter to those set. */
  onFilterBy: (filter: AuditFilter) => void
}) => {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const time = formatFullTimestamp(record.at)
  return (
    <>
      <Table.Row>
        <Table.Cell className="w-0 pr-0">
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
        <Table.Cell className="whitespace-nowrap text-sm text-kumo-subtle">
          <time dateTime={record.at.toISOString()} title={record.at.toISOString()}>{time}</time>
        </Table.Cell>
        <Table.Cell className="max-w-56">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 max-w-full text-sm"
            aria-label={`Show only ${record.admin}’s activity`}
            onClick={() => onFilterBy({ admin: record.admin })}
          >
            <span className="truncate">{record.admin}</span>
          </Button>
        </Table.Cell>
        <Table.Cell className="font-mono text-xs text-kumo-default">{record.method}</Table.Cell>
        <Table.Cell className="whitespace-nowrap">
          <span className="flex items-center gap-1.5">
            <SensitivityBadge sensitivity={sensitivityOf(record)} />
            {record.kind === 'workspace' && record.refused && (
              <span title={REFUSAL_NAMES[record.refused]}><Badge variant="warning">Refused</Badge></span>
            )}
          </span>
        </Table.Cell>
        <Table.Cell className={`max-w-72 text-xs text-kumo-subtle${record.kind === 'setting' ? ' font-mono' : ''}`}>
          <span className="block truncate" title={summaryOf(record)}>{summaryOf(record)}</span>
        </Table.Cell>
        <Table.Cell className="text-sm text-kumo-subtle">{VIA_NAMES[record.via]}</Table.Cell>
      </Table.Row>
      <Table.Row id={detailsId} hidden={!expanded}>
        <Table.Cell colSpan={AUDIT_LOG_COLUMNS} className="bg-kumo-recessed">
          {expanded && (record.kind === 'workspace'
            ? <AccessDetails record={record} onFilterBy={onFilterBy} />
            : <SettingChanges changes={record.changes} />)}
        </Table.Cell>
      </Table.Row>
    </>
  )
}
