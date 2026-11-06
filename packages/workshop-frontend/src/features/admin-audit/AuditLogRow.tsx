import { useId, useState } from 'react'
import { Button, Table } from '@cloudflare/kumo'
import { CaretRight } from '@phosphor-icons/react'
import type { AdminAuditRecord, AdminSettingChange, AdminVia } from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { AuditValue } from './AuditValue'

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

// What a record changed, in one line: its first change, and how many more it made.
const changesSummary = (changes: AdminSettingChange[]) => {
  if (changes.length === 0) return ''
  const more = changes.length - 1
  return more === 0 ? changeName(changes[0]) : `${changeName(changes[0])} + ${NUMBER.format(more)} more`
}

/**
 * One record of the Audit tab's log: a summary row, with a toggle that shows what the record holds
 * in full in a row below it. The admin's name filters the log by that admin.
 */
export const AuditLogRow = ({ record, onAdminSelect }: {
  record: AdminAuditRecord
  onAdminSelect: (admin: string) => void
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
            onClick={() => onAdminSelect(record.admin)}
          >
            <span className="truncate">{record.admin}</span>
          </Button>
        </Table.Cell>
        <Table.Cell className="font-mono text-xs text-kumo-default">{record.method}</Table.Cell>
        <Table.Cell className="max-w-80 font-mono text-xs text-kumo-subtle">
          <span className="block truncate" title={changesSummary(record.changes)}>
            {changesSummary(record.changes)}
          </span>
        </Table.Cell>
        <Table.Cell className="text-sm text-kumo-subtle">{VIA_NAMES[record.via]}</Table.Cell>
      </Table.Row>
      <Table.Row id={detailsId} hidden={!expanded}>
        <Table.Cell colSpan={AUDIT_LOG_COLUMNS} className="bg-kumo-recessed">
          {expanded && <SettingChanges changes={record.changes} />}
        </Table.Cell>
      </Table.Row>
    </>
  )
}
