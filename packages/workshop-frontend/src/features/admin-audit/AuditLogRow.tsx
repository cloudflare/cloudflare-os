import { useId, useState, type ReactNode } from 'react'
import { Badge, Button, Table } from '@cloudflare/kumo'
import { CaretRight } from '@phosphor-icons/react'
import { Link } from '@tanstack/react-router'
import type {
  AdminAccessRecord,
  AdminAgentOrigin,
  AdminAuditRecord,
  AdminGrantRecord,
  AdminSettingChange,
  AdminUserAccessRecord,
  AdminVia,
  AdminWriteRecord,
} from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { ACCESS_LEVEL_NAMES, REFUSAL_NAMES, openedForName } from './accessNames'
import { targetUserOf, type AuditFilter } from './auditFilter'
import { AuditValue } from './AuditValue'
import { ExposureBadge } from './ExposureBadge'
import { KindBadge } from './KindBadge'

/** How many columns an AuditLogRow fills, for the table's empty and detail rows. */
export const AUDIT_LOG_COLUMNS = 6

const VIA_NAMES: Record<AdminVia, string> = { api: 'API', cli: 'CLI', gatekeeper: 'Admin connection' }

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

// A workspace by its id, with the way to the admin's page for it.
const WorkspaceReference = ({ workspaceId }: { workspaceId: string }) => (
  <>
    <span className="block font-mono text-xs text-kumo-subtle break-all">{workspaceId}</span>
    <Link
      to="/admin/workspace/$workspaceId"
      params={{ workspaceId }}
      className="text-kumo-brand hover:underline"
    >
      Open workspace admin view
    </Link>
  </>
)

// The workspace a record names: its title, which filters the log by that workspace, its id, and
// the way to the admin's page for it.
const WorkspaceDetail = ({ record, onFilterBy }: {
  record: AdminAccessRecord | AdminWriteRecord | AdminGrantRecord
  onFilterBy: (filter: AuditFilter) => void
}) => (
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
    <WorkspaceReference workspaceId={record.workspaceId} />
  </Detail>
)

// A record's arguments by name, left out when it has none.
const ArgumentsDetail = ({ args }: { args: AdminAccessRecord['args'] }) => {
  const entries = Object.entries(args)
  if (entries.length === 0) return null
  return (
    <Detail term="Arguments">
      <span className="font-mono text-xs">
        {entries.map(([name, value]) => `${name}: ${String(value)}`).join(' · ')}
      </span>
    </Detail>
  )
}

// A call into a workspace or a user's account. What a workspace's view was opened for is said
// only when that is not metadata, and its grant only when the call ran under one: a record has
// no line for a field it lacks.
// Where a call made through the admin gatekeeper came from: the workspace whose connection made
// it, with the way to the admin's page for it, and the chat, when the workspace tied the call to
// one. The terms say "from", since the record's own workspace is the one the call reached.
const AgentOriginDetails = ({ agent }: { agent: AdminAgentOrigin }) => (
  <>
    <Detail term="From workspace"><WorkspaceReference workspaceId={agent.workspaceId} /></Detail>
    {agent.chatId !== undefined && <Detail term="From chat">{agent.chatId}</Detail>}
  </>
)

const AccessDetails = ({ record, onFilterBy }: {
  record: AdminAccessRecord | AdminUserAccessRecord
  onFilterBy: (filter: AuditFilter) => void
}) => {
  const openedFor = record.kind === 'workspace' ? openedForName(record.requested) : undefined
  return (
    <dl className="space-y-2">
      {record.kind === 'workspace'
        ? <WorkspaceDetail record={record} onFilterBy={onFilterBy} />
        : <Detail term="Account">{record.userId || 'Unknown'}</Detail>}
      <Detail term="Reason">{record.reason}</Detail>
      {openedFor !== undefined && <Detail term="Opened for">{openedFor}</Detail>}
      <Detail term="Access">
        {ACCESS_LEVEL_NAMES[record.access]}
        {record.refused && <> · refused: {REFUSAL_NAMES[record.refused]}</>}
      </Detail>
      {record.kind === 'workspace' && record.grantId && (
        <Detail term="Under grant"><span className="font-mono text-xs break-all">{record.grantId}</span></Detail>
      )}
      <ArgumentsDetail args={record.args} />
      <Detail term="Via">{VIA_NAMES[record.via]}</Detail>
      {record.agent && <AgentOriginDetails agent={record.agent} />}
    </dl>
  )
}

const WriteDetails = ({ record, onFilterBy }: {
  record: AdminWriteRecord
  onFilterBy: (filter: AuditFilter) => void
}) => (
  <dl className="space-y-2">
    <WorkspaceDetail record={record} onFilterBy={onFilterBy} />
    <Detail term="Reason">{record.reason}</Detail>
    <ArgumentsDetail args={record.args} />
    <Detail term="Via">{VIA_NAMES[record.via]}</Detail>
    {record.agent && <AgentOriginDetails agent={record.agent} />}
  </dl>
)

// One step of a request to read a workspace's content without its owner: the request, its
// denial, its approval, or the early end of the grant it gave.
const GrantDetails = ({ record, onFilterBy }: {
  record: AdminGrantRecord
  onFilterBy: (filter: AuditFilter) => void
}) => (
  <dl className="space-y-2">
    <WorkspaceDetail record={record} onFilterBy={onFilterBy} />
    <Detail term="Request"><span className="font-mono text-xs break-all">{record.requestId}</span></Detail>
    <Detail term="Reason">{record.reason}</Detail>
    {record.requestedBy !== record.admin && <Detail term="Requested by">{record.requestedBy}</Detail>}
    {/* The id the reads made under the grant carry (see "Under grant" on an access record). */}
    {record.grantId && (
      <Detail term="Grant"><span className="font-mono text-xs break-all">{record.grantId}</span></Detail>
    )}
    {record.replacedGrantId && (
      <Detail term="Ended grant"><span className="font-mono text-xs break-all">{record.replacedGrantId}</span></Detail>
    )}
    {record.endReason && <Detail term="Reason for ending">{record.endReason}</Detail>}
    <Detail term="Via">{VIA_NAMES[record.via]}</Detail>
    {record.agent && <AgentOriginDetails agent={record.agent} />}
  </dl>
)

/**
 * One record of the Audit tab's log: a summary row (time, admin, action, kind, target user),
 * with a toggle that shows the rest in a row below it: how the call came (for one an agent made
 * through the admin gatekeeper, also the workspace and the chat it came from), and a setting
 * record's changes, an access record's workspace or account, reason, level and arguments, with
 * what a workspace's view was opened for when that is content and the grant the call ran under
 * when it had one, a write record's workspace, reason and arguments, or a grant record's
 * workspace, request, reason and what its step adds: who requested it, the grant, the reason an
 * admin gave for ending it. A workspace access record's kind is followed by a badge for what the
 * call exposed, when the record says, and an access record's by its refusal. An access, a write
 * or a grant record's target user is the user the call reached: its workspace's owner, or the
 * user whose account a call was made into. The admin's name and the target user, and in a
 * workspace, write or grant record's details its workspace, filter the log by `onFilterBy`; those
 * details also link the admin's page for the workspace. Names are never cut: an action too long
 * for the space left is, whole in its tooltip. `shaded` stripes the summary row as Kumo stripes a
 * table's even rows: Kumo counts the details row below each one, hidden or not, so every summary
 * row is an odd row to it and would never be striped.
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
  const target = targetUserOf(record)
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
            {record.kind === 'workspace' && <ExposureBadge exposed={record.exposed} />}
            {(record.kind === 'workspace' || record.kind === 'user') && record.refused && (
              <span title={REFUSAL_NAMES[record.refused]}><Badge variant="warning">Refused</Badge></span>
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
            : target
              ? (
                <NameFilter
                  name={target}
                  label={`Show only calls targeting ${target}`}
                  onFilter={() => onFilterBy({ owner: target })}
                />
              )
              : <span className="text-sm text-kumo-subtle">Unknown</span>}
        </Table.Cell>
      </Table.Row>
      <Table.Row id={detailsId} hidden={!expanded}>
        <Table.Cell colSpan={AUDIT_LOG_COLUMNS} className="bg-kumo-recessed">
          {expanded && (record.kind === 'workspace' || record.kind === 'user'
            ? <AccessDetails record={record} onFilterBy={onFilterBy} />
            : record.kind === 'write'
              ? <WriteDetails record={record} onFilterBy={onFilterBy} />
              : record.kind === 'grant'
                ? <GrantDetails record={record} onFilterBy={onFilterBy} />
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
