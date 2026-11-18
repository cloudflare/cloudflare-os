import { useId, useState, type ReactNode } from 'react'
import { CaretRightIcon } from '@phosphor-icons/react'
import type { AdminAccessRecord, AdminAuditRecord, AdminSettingChange, AdminUserAccessRecord } from '@gadgets/workshop-shared/api'
import { Tag } from '@/components/Tag'
import { targetUserOf, type AuditFilter } from './auditFilter'
import { ACCESS_LEVEL_NAMES, changeName, excerptLabel, KIND_NAMES, REFUSAL_NAMES, VIA_NAMES } from './auditText'
import { AuditValue } from './AuditValue'

const TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

// One thing said of the record, under what it is: beside it where there is room.
const Detail = ({ term, children }: { term: string; children: ReactNode }) => (
  <div className="grid gap-x-4 gap-y-0.5 @md:grid-cols-[8rem_minmax(0,1fr)]">
    <dt className="text-sm text-kumo-subtle">{term}</dt>
    <dd className="min-w-0 text-sm wrap-anywhere text-kumo-default">{children}</dd>
  </div>
)

// A name, or a workspace, that narrows the log to it when chosen: underlined faintly, as a link
// is, since it is in what is said rather than among the row's buttons.
const NarrowTo = ({ label, onSelect, children }: { label: string; onSelect: () => void; children: ReactNode }) => (
  <button
    type="button"
    aria-label={label}
    onClick={onSelect}
    className="cursor-pointer text-left wrap-anywhere underline decoration-kumo-line underline-offset-2 hover:decoration-current"
  >
    {children}
  </button>
)

const SettingChanges = ({ changes }: { changes: AdminSettingChange[] }) => (
  <ul className="flex flex-col gap-4">
    {changes.map((change, index) => (
      <li key={index} className="flex flex-col gap-1.5">
        <p className="font-mono text-sm wrap-anywhere text-kumo-default">{changeName(change)}</p>
        <div className="grid gap-3 @md:grid-cols-2">
          {(['before', 'after'] as const).map((side) => (
            <div key={side} className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-kumo-base p-3 ring-1 ring-kumo-line">
              <p className="text-sm text-kumo-subtle">{side === 'before' ? 'Before' : 'After'}</p>
              <AuditValue value={change[side]} label={`${changeName(change)}, ${side}`} />
            </div>
          ))}
        </div>
        {change.excerpt && <p className="text-sm text-kumo-subtle">{excerptLabel(change.excerpt)}</p>}
      </li>
    ))}
  </ul>
)

const AccessDetails = ({ record }: { record: AdminAccessRecord | AdminUserAccessRecord }) => {
  const args = Object.entries(record.args)
  return (
    <>
      <Detail term="Reason">{record.reason}</Detail>
      <Detail term="Access">
        {ACCESS_LEVEL_NAMES[record.access]}
        {record.refused && `, refused: ${REFUSAL_NAMES[record.refused]}`}
      </Detail>
      {args.length > 0 && (
        <Detail term="Arguments">
          <span className="font-mono">{args.map(([name, value]) => `${name}: ${String(value)}`).join(' · ')}</span>
        </Detail>
      )}
    </>
  )
}

export type AuditRecordRowProps = {
  record: AdminAuditRecord
  /** Narrows the log further, by what was chosen in the record's details. */
  onFilterBy: (filter: AuditFilter) => void
}

/**
 * One record of the audit log, on a line of its own: what was called and the kind of record, a
 * refused call marked as one, then who called it and when, and whom it reached. It opens to the
 * rest beneath it: the admin, the user reached and the workspace, each of which narrows the log to
 * it, how the call came, and a setting change's values before and after, or a call's reason, level
 * and arguments. Ported from main's Audit tab, which drew it as a table's row.
 */
export const AuditRecordRow = ({ record, onFilterBy }: AuditRecordRowProps) => {
  const [open, setOpen] = useState(false)
  const id = useId()
  const time = TIME.format(record.at)
  const target = targetUserOf(record)
  const reached = record.kind === 'setting' ? 'Deployment-wide' : target ? `Reached ${target}` : 'Reached someone unknown'

  return (
    <li className="@container border-t border-kumo-line first:border-t-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((shown) => !shown)}
        className="group flex w-full cursor-pointer items-start gap-3 py-3 text-left"
      >
        {/* On the first line's middle, however many lines there are. */}
        <span className="flex h-[1lh] items-center text-kumo-subtle group-hover:text-kumo-default">
          <CaretRightIcon aria-hidden="true" weight="bold" className={`size-3 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 font-mono text-sm wrap-anywhere text-kumo-default">{record.method}</span>
            <Tag>{KIND_NAMES[record.kind]}</Tag>
            {record.kind !== 'setting' && record.refused && <Tag className="border-kumo-warning text-kumo-warning">Refused</Tag>}
          </span>
          <span className="text-sm wrap-anywhere text-kumo-subtle">
            {record.admin} · <time dateTime={record.at.toISOString()}>{time}</time> · {reached}
          </span>
        </span>
      </button>
      {open && (
        <div id={id} className="flex flex-col gap-4 pb-4 ps-6">
          <dl className="flex flex-col gap-2">
            <Detail term="Admin">
              <NarrowTo label={`Show only ${record.admin}’s activity`} onSelect={() => onFilterBy({ admin: record.admin })}>{record.admin}</NarrowTo>
            </Detail>
            {record.kind === 'workspace' && (
              <Detail term="Workspace">
                <NarrowTo label={`Show only calls into ${record.workspaceTitle || record.workspaceId}`} onSelect={() => onFilterBy({ workspace: record.workspaceId })}>
                  {record.workspaceTitle || 'Untitled'}
                </NarrowTo>
                <span className="block font-mono text-kumo-subtle">{record.workspaceId}</span>
              </Detail>
            )}
            {record.kind !== 'setting' && (
              <Detail term={record.kind === 'user' ? 'Account' : 'Owner'}>
                {target
                  ? <NarrowTo label={`Show only calls that reached ${target}`} onSelect={() => onFilterBy({ owner: target })}>{target}</NarrowTo>
                  : 'Unknown'}
              </Detail>
            )}
            {record.kind !== 'setting' && <AccessDetails record={record} />}
            <Detail term="Via">{VIA_NAMES[record.via]}</Detail>
          </dl>
          {record.kind === 'setting' && <SettingChanges changes={record.changes} />}
        </div>
      )}
    </li>
  )
}
